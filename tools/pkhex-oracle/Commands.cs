using System.Text.Json.Nodes;
using PKHeX.Core;

namespace PkhexOracle;

internal static class Commands
{
    // ------------------------------------------------------------------ blank / build / dump

    public static JsonNode Blank(string[] args)
    {
        if (args.Length != 3)
            throw new OracleException("usage: blank <GameVersion> <lang> <out.sav>");
        var game = Util.ParseGame(args[0]);
        var lang = Util.ParseLang(args[1]);
        var (sav, notes) = Skeleton.Create(game, lang, Builder.DefaultTrainerName(lang), null);
        return WriteAndDump(sav, args[2], "blank", [], notes);
    }

    public static JsonNode Build(string[] args)
    {
        if (args.Length != 2)
            throw new OracleException("usage: build <spec.json> <out.sav>");
        var spec = Util.ReadJsonFile(args[0]) as JsonObject ?? throw new OracleException("spec must be a JSON object");
        var (sav, warnings, notes) = Builder.BuildSave(spec);
        return WriteAndDump(sav, args[1], "build", warnings, notes);
    }

    public static JsonNode Dump(string[] args)
    {
        if (args.Length != 1)
            throw new OracleException("usage: dump <in.sav>");
        var sav = Dumper.LoadSave(args[0]);
        return Dumper.Save(sav, args[0]);
    }

    /// <summary>
    /// Loads a save, re-serialises it with PKHeX (no edits) and reports whether the bytes and the
    /// dump survive. Differences show what PKHeX normalises on write.
    /// </summary>
    public static JsonNode RoundTrip(string[] args)
    {
        if (args.Length != 1)
            throw new OracleException("usage: roundtrip <in.sav>");
        var original = File.ReadAllBytes(args[0]);
        var sav = Dumper.LoadSave(args[0]);
        var before = Json.Write(Dumper.Save(sav));
        var notes = new List<string>();
        var rewritten = Skeleton.Finish(sav, sav.Write(), notes);
        var tmp = Path.Combine(Path.GetTempPath(), $"pkhex-oracle-roundtrip-{Environment.ProcessId}.sav");
        File.WriteAllBytes(tmp, rewritten);
        string after;
        try
        {
            after = Json.Write(Dumper.Save(Dumper.LoadSave(tmp)));
        }
        finally
        {
            File.Delete(tmp);
        }

        var diffs = new JsonArray();
        int count = 0;
        int n = Math.Min(original.Length, rewritten.Length);
        for (int i = 0; i < n; i++)
        {
            if (original[i] == rewritten[i])
                continue;
            if (count++ < 32)
                diffs.Add(new JsonObject { ["offset"] = i, ["hexOffset"] = $"0x{i:X5}", ["before"] = original[i], ["after"] = rewritten[i] });
        }
        return new JsonObject
        {
            ["ok"] = true,
            ["file"] = args[0],
            ["sizeBefore"] = original.Length,
            ["sizeAfter"] = rewritten.Length,
            ["bytesIdentical"] = original.Length == rewritten.Length && count == 0,
            ["differingBytes"] = count,
            ["firstDifferences"] = diffs,
            ["dumpIdentical"] = before == after,
        };
    }

    private static JsonObject WriteAndDump(SaveFile sav, string outPath, string command, List<string> warnings, List<string>? notes = null)
    {
        notes ??= [];
        var bytes = Skeleton.Finish(sav, sav.Write(), notes);
        var dir = Path.GetDirectoryName(Path.GetFullPath(outPath));
        if (dir is not null)
            Directory.CreateDirectory(dir);
        File.WriteAllBytes(outPath, bytes);

        // Always describe the file as PKHeX reads it back, not the in-memory object.
        var reloaded = Dumper.LoadSave(outPath);
        return new JsonObject
        {
            ["ok"] = true,
            ["command"] = command,
            ["out"] = outPath,
            ["size"] = bytes.Length,
            ["sha256"] = Util.Sha256(bytes),
            ["warnings"] = warnings.ToJsonArray(),
            ["notes"] = notes.ToJsonArray(),
            ["save"] = Dumper.Save(reloaded, outPath),
        };
    }

    // ------------------------------------------------------------------ records

    public sealed record ParsedRecord(PKM Pk, RawSlot Raw, bool Party, string Layout);

    /// <summary>
    /// Parses one record. Accepted layouts:
    /// pk1/pk2 — box struct + OT + nickname (the repo's record format), party struct + OT + nickname,
    ///           or PKHeX's own single-entry list (.pk1/.pk2 files);
    /// pk3/pk4/pk5 — encrypted box (record format) or party data; with decrypted=true, decrypted bytes.
    /// </summary>
    public static ParsedRecord ParseRecord(byte format, byte[] data, bool decrypted = false, bool egg = false)
    {
        switch (format)
        {
            case 1:
            case 2:
            {
                int box = format == 1 ? Sizes._1STORED : Sizes._2STORED;
                int party = format == 1 ? Sizes._1PARTY : Sizes._2PARTY;
                int singleInt = format == 1 ? Sizes._1ULIST : Sizes._2ULIST;
                int singleJp = format == 1 ? Sizes._1JLIST : Sizes._2JLIST;
                if (data.Length == singleInt || data.Length == singleJp)
                {
                    PKM pk1 = format == 1 ? PokeList1.ReadFromSingle(data) : PokeList2.ReadFromSingle(data);
                    int nl = data.Length == singleJp ? 6 : 11;
                    var raw1 = new RawSlot(data.AsSpan(3, party).ToArray(), data.AsSpan(3 + party, nl).ToArray(), data.AsSpan(3 + party + nl, nl).ToArray(), data[1], 0);
                    if (egg && pk1 is PK2 e1)
                        e1.IsEgg = true;
                    return new ParsedRecord(pk1, raw1, true, "pkhex-single-list");
                }

                // The repo's pk2 record: list entry (species, or 0xFD = Egg) + box struct + OT + nickname.
                if (format == 2)
                {
                    foreach (var nl in new[] { 11, 6 })
                    {
                        if (data.Length != 1 + box + (2 * nl))
                            continue;
                        var body = data.AsSpan(1, box);
                        var pk = new PK2(body, data.AsSpan(1 + box, nl), data.AsSpan(1 + box + nl, nl));
                        if (data[0] == 0xFD || egg)
                            pk.IsEgg = true;
                        var raw = new RawSlot(body.ToArray(), data.AsSpan(1 + box, nl).ToArray(), data.AsSpan(1 + box + nl, nl).ToArray(), data[0]);
                        return new ParsedRecord(pk, raw, false, "record" + (nl == 6 ? " (jp)" : ""));
                    }
                }

                foreach (var (bodyLen, isParty) in new[] { (box, false), (party, true) })
                {
                    foreach (var nl in new[] { 11, 6 })
                    {
                        if (data.Length != bodyLen + (2 * nl))
                            continue;
                        var body = data.AsSpan(0, bodyLen);
                        var ot = data.AsSpan(bodyLen, nl);
                        var nick = data.AsSpan(bodyLen + nl, nl);
                        PKM pk = format == 1 ? new PK1(body, ot, nick) : new PK2(body, ot, nick);
                        if (egg)
                        {
                            if (pk is not PK2 p2)
                                throw new OracleException("--egg only applies to pk2");
                            p2.IsEgg = true;
                        }
                        var raw = new RawSlot(body.ToArray(), ot.ToArray(), nick.ToArray());
                        return new ParsedRecord(pk, raw, isParty, (isParty ? "party" : "box") + "+names" + (nl == 6 ? " (jp)" : ""));
                    }
                }
                throw new OracleException($"pk{format}: {data.Length} bytes matches no known layout (box {box}+2x11/2x6, party {party}+2x11/2x6, single list {singleInt}/{singleJp})");
            }
            case 3:
            case 4:
            case 5:
            {
                int stored = format switch { 3 => Sizes._3STORED, 4 => Sizes._4STORED, _ => Sizes._5STORED };
                int party = format switch { 3 => Sizes._3PARTY, 4 => Sizes._4PARTY, _ => Sizes._5PARTY };
                if (data.Length != stored && data.Length != party)
                    throw new OracleException($"pk{format}: expected {stored} (box) or {party} (party) bytes, got {data.Length}");
                bool isParty = data.Length == party;
                byte[] plain;
                byte[] enc;
                if (decrypted)
                {
                    plain = data.ToArray();
                    enc = format == 3 ? PokeCrypto.EncryptArray3(plain) : PokeCrypto.EncryptArray45(plain);
                }
                else
                {
                    enc = data.ToArray();
                    plain = format == 3 ? PokeCrypto.DecryptArray3(data.ToArray()) : PokeCrypto.DecryptArray45(data.ToArray());
                }
                // Same path a save takes for a slot: decrypt, then construct.
                PKM pk = format switch { 3 => new PK3(plain.ToArray()), 4 => new PK4(plain.ToArray()), _ => new PK5(plain.ToArray()) };
                return new ParsedRecord(pk, new RawSlot(enc), isParty, (isParty ? "party" : "box") + (decrypted ? " (decrypted input)" : " (encrypted)"));
            }
        }
        throw new OracleException($"unsupported format pk{format}");
    }

    private static (List<string> Positional, HashSet<string> Flags) SplitArgs(string[] args)
    {
        var pos = new List<string>();
        var flags = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var a in args)
        {
            if (a.StartsWith("--", StringComparison.Ordinal))
                flags.Add(a[2..]);
            else
                pos.Add(a);
        }
        return (pos, flags);
    }

    public static JsonNode Pkm(string[] args)
    {
        var (pos, flags) = SplitArgs(args);
        if (pos.Count != 2)
            throw new OracleException("usage: pkm <pk1..pk5> <hex> [--decrypted] [--egg]");
        var format = Util.ParseFormat(pos[0]);
        var rec = ParseRecord(format, Util.ParseHex(pos[1]), flags.Contains("decrypted"), flags.Contains("egg"));
        return new JsonObject
        {
            ["ok"] = true,
            ["oracle"] = new JsonObject { ["tool"] = "pkhex-oracle", ["pkhexCore"] = Util.PkhexVersion },
            ["input"] = new JsonObject { ["format"] = Util.FormatName(format), ["bytes"] = pos[1].Length / 2, ["layout"] = rec.Layout },
            ["pkm"] = Dumper.Mon(rec.Pk, rec.Raw, rec.Party),
        };
    }

    /// <summary>PKHeX's blank (empty-slot) entity for a format, as a box record.</summary>
    public static JsonNode BlankPkm(string[] args)
    {
        if (args.Length != 1)
            throw new OracleException("usage: blankpkm <pk1..pk5>");
        var format = Util.ParseFormat(args[0]);
        PKM pk = format switch
        {
            1 => new PK1(),
            2 => new PK2(),
            3 => new PK3(),
            4 => new PK4(),
            _ => new PK5(),
        };
        byte[] hex = format <= 2 ? [.. pk.Data.AsSpan(0, pk.SIZE_STORED), .. pk.OriginalTrainerTrash, .. pk.NicknameTrash] : pk.EncryptedBoxData;
        var rec = ParseRecord(format, hex);
        return new JsonObject
        {
            ["ok"] = true,
            ["oracle"] = new JsonObject { ["tool"] = "pkhex-oracle", ["pkhexCore"] = Util.PkhexVersion },
            ["recordHex"] = Util.Hex(hex),
            ["pkm"] = Dumper.Mon(rec.Pk, rec.Raw, rec.Party),
        };
    }

    // ------------------------------------------------------------------ convert

    private static Type FormatType(byte format) => format switch
    {
        1 => typeof(PK1),
        2 => typeof(PK2),
        3 => typeof(PK3),
        4 => typeof(PK4),
        5 => typeof(PK5),
        _ => throw new OracleException("unsupported target"),
    };

    public static JsonNode Convert(string[] args)
    {
        var (pos, flags) = SplitArgs(args);
        if (pos.Count != 3)
            throw new OracleException("usage: convert <fromFormat> <toFormat> <hex> [--decrypted] [--egg]");
        var from = Util.ParseFormat(pos[0]);
        var toText = pos[1].Trim().ToLowerInvariant();
        var rec = ParseRecord(from, Util.ParseHex(pos[2]), flags.Contains("decrypted"), flags.Contains("egg"));

        Type dest = toText switch
        {
            "pk6" => typeof(PK6),
            "pk7" => typeof(PK7),
            _ => FormatType(Util.ParseFormat(toText)),
        };

        var input = rec.Pk.Clone();
        var converted = EntityConverter.ConvertToType(input, dest, out var result);
        var o = new JsonObject
        {
            ["oracle"] = new JsonObject { ["tool"] = "pkhex-oracle", ["pkhexCore"] = Util.PkhexVersion, ["now"] = EncounterDate.GetDateNDS().ToString("yyyy-MM-dd") },
            ["from"] = Util.FormatName(from),
            ["to"] = toText,
            ["ok"] = converted is not null,
            ["result"] = result.ToString(),
            ["resultMessage"] = result.GetDisplayString(rec.Pk, dest),
            ["input"] = Dumper.Mon(rec.Pk, rec.Raw, rec.Party),
        };
        if (converted is null)
        {
            o["output"] = null;
            return o;
        }

        if (converted.Format <= 5)
        {
            // Describe the result as a box record, the form the widget stores.
            var asStored = converted.Format <= 2 ? converted : RecordRoundTrip(converted);
            o["output"] = Dumper.Mon(asStored, null, party: false);
        }
        else
        {
            o["output"] = Dumper.MonSummary(converted);
            o["note"] = "Gen 6+ output is summarised; PKHeX fills it with random values (encryption constant, IVs, PID).";
        }
        return o;
    }

    /// <summary>Encrypts as a box record and parses it back, exactly as a save slot would.</summary>
    private static PKM RecordRoundTrip(PKM pk)
    {
        var enc = pk.EncryptedBoxData;
        return ParseRecord(pk.Format, enc).Pk;
    }

    // ------------------------------------------------------------------ modify

    public static JsonNode Modify(string[] args)
    {
        if (args.Length != 3)
            throw new OracleException("usage: modify <in.sav> <out.sav> <ops.json>");
        var sav = Dumper.LoadSave(args[0]);
        var opsNode = Util.ReadJsonFile(args[2]);
        var ops = opsNode as JsonArray ?? (opsNode as JsonObject)?.Arr("ops") ?? throw new OracleException("ops.json must be an array or {\"ops\": [...]}");
        var applied = new JsonArray();
        var warnings = new List<string>();
        foreach (var node in ops)
        {
            var op = node as JsonObject ?? throw new OracleException("each op must be an object");
            applied.Add(Apply(sav, op, warnings));
        }
        var result = WriteAndDump(sav, args[1], "modify", warnings, []);
        result["applied"] = applied;
        return result;
    }

    private static JsonObject Apply(SaveFile sav, JsonObject op, List<string> warnings)
    {
        var name = op.Str("op") ?? throw new OracleException("op needs an 'op' field");
        var dex = (op.Bool("registerDex") ?? false) ? PKMImportSetting.Update : PKMImportSetting.Skip;
        var trade = (op.Bool("adapt") ?? false) ? PKMImportSetting.Update : PKMImportSetting.Skip;
        switch (name)
        {
            case "deleteBox":
            {
                int b = op.Int("box") ?? throw new OracleException("deleteBox needs box");
                int s = op.Int("slot") ?? throw new OracleException("deleteBox needs slot");
                var before = sav.GetBoxSlotAtIndex(b, s);
                sav.SetBoxSlotAtIndex(sav.BlankPKM, b, s, PKMImportSetting.Skip, PKMImportSetting.Skip);
                return new JsonObject { ["op"] = name, ["box"] = b, ["slot"] = s, ["removedSpecies"] = before.Species };
            }
            case "deleteParty":
            {
                int s = op.Int("slot") ?? throw new OracleException("deleteParty needs slot");
                if ((uint)s >= sav.PartyCount)
                    throw new OracleException($"party slot {s} is empty (party count {sav.PartyCount})");
                var before = sav.GetPartySlotAtIndex(s);
                sav.DeletePartySlot(s);
                return new JsonObject { ["op"] = name, ["slot"] = s, ["removedSpecies"] = before.Species, ["partyCount"] = sav.PartyCount };
            }
            case "setBox":
            case "setParty":
            {
                var format = Util.ParseFormat(op.Str("format") ?? Util.FormatName(sav.Generation));
                if (format != sav.Generation)
                    throw new OracleException($"{name}: record is pk{format} but the save is Gen {sav.Generation}; convert it first");
                var hexText = op.Str("hex") ?? (op.Str("hexFile") is { } hf ? File.ReadAllText(hf) : null) ?? throw new OracleException($"{name} needs hex or hexFile");
                var rec = ParseRecord(format, Util.ParseHex(hexText), op.Bool("decrypted") ?? false, op.Bool("egg") ?? false);
                var pk = rec.Pk;
                if (sav.Generation <= 2 && Raw.IsJapaneseGB(sav) != pk.Japanese)
                    throw new OracleException($"{name}: Japanese/international mismatch between record and save");
                if (name == "setBox")
                {
                    int b = op.Int("box") ?? throw new OracleException("setBox needs box");
                    int s = op.Int("slot") ?? throw new OracleException("setBox needs slot");
                    sav.SetBoxSlotAtIndex(pk, b, s, trade, dex);
                    return new JsonObject { ["op"] = name, ["box"] = b, ["slot"] = s, ["species"] = pk.Species };
                }
                else
                {
                    int s = op.Int("slot") ?? sav.PartyCount;
                    if (s > sav.PartyCount)
                        throw new OracleException($"setParty slot {s} would leave a gap (party count {sav.PartyCount})");
                    if (pk.Stat_HPMax == 0)
                        pk.ResetPartyStats();
                    sav.SetPartySlotAtIndex(pk, s, trade, dex);
                    return new JsonObject { ["op"] = name, ["slot"] = s, ["species"] = pk.Species, ["partyCount"] = sav.PartyCount };
                }
            }
            case "setCurrentBox":
            {
                int b = op.Int("box") ?? throw new OracleException("setCurrentBox needs box");
                sav.CurrentBox = b;
                return new JsonObject { ["op"] = name, ["box"] = b };
            }
            case "registerDex":
            {
                int sp = op.Int("species") ?? throw new OracleException("registerDex needs species");
                bool seen = op.Bool("seen") ?? true;
                bool caught = op.Bool("caught") ?? true;
                sav.SetSeen((ushort)sp, seen);
                sav.SetCaught((ushort)sp, caught);
                return new JsonObject { ["op"] = name, ["species"] = sp, ["seen"] = seen, ["caught"] = caught };
            }
            default:
                throw new OracleException($"unknown op '{name}' (deleteBox, deleteParty, setBox, setParty, setCurrentBox, registerDex)");
        }
    }
}
