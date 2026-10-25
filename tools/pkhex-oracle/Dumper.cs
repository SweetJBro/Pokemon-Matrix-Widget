using System.Text.Json.Nodes;
using PKHeX.Core;

namespace PkhexOracle;

/// <summary>Turns PKHeX's view of saves and entities into JSON.</summary>
internal static class Dumper
{
    // ------------------------------------------------------------------ entities

    private static readonly GameStrings Names = GameInfo.GetStrings("en");

    private static string? Name(IReadOnlyList<string> list, int index) => (uint)index < list.Count && list[index].Length != 0 ? list[index] : null;

    public static JsonObject Mon(PKM pk, RawSlot? raw = null, bool party = false)
    {
        byte gen = pk.Format;
        bool gb = gen <= 2;
        var o = new JsonObject
        {
            ["format"] = Util.FormatName(gen),
            ["species"] = pk.Species,
            ["speciesName"] = SpeciesName.GetSpeciesName(pk.Species, (int)LanguageID.English),
            ["form"] = pk.Form,
            ["nickname"] = pk.Nickname,
            ["isNicknamed"] = pk.IsNicknamed,
            ["isEgg"] = pk.IsEgg,
            ["level"] = pk.CurrentLevel,
            ["exp"] = pk.EXP,
        };

        var moves = new JsonArray();
        ushort[] ids = [pk.Move1, pk.Move2, pk.Move3, pk.Move4];
        int[] pp = [pk.Move1_PP, pk.Move2_PP, pk.Move3_PP, pk.Move4_PP];
        int[] ups = [pk.Move1_PPUps, pk.Move2_PPUps, pk.Move3_PPUps, pk.Move4_PPUps];
        for (int i = 0; i < 4; i++)
            moves.Add(new JsonObject { ["id"] = ids[i], ["name"] = ids[i] == 0 ? null : Name(Names.Move, ids[i]), ["pp"] = pp[i], ["ppUps"] = ups[i] });
        o["moves"] = moves;

        if (gb)
        {
            var g = (GBPKM)pk;
            o["ivs"] = new JsonObject { ["hp"] = pk.IV_HP, ["atk"] = pk.IV_ATK, ["def"] = pk.IV_DEF, ["spa"] = pk.IV_SPA, ["spd"] = pk.IV_SPD, ["spe"] = pk.IV_SPE };
            o["dvs"] = new JsonObject { ["hp"] = pk.IV_HP, ["atk"] = pk.IV_ATK, ["def"] = pk.IV_DEF, ["spe"] = pk.IV_SPE, ["spc"] = g.IV_SPC };
            o["evs"] = new JsonObject { ["hp"] = pk.EV_HP, ["atk"] = pk.EV_ATK, ["def"] = pk.EV_DEF, ["spa"] = pk.EV_SPA, ["spd"] = pk.EV_SPD, ["spe"] = pk.EV_SPE };
            o["statExp"] = new JsonObject { ["hp"] = pk.EV_HP, ["atk"] = pk.EV_ATK, ["def"] = pk.EV_DEF, ["spe"] = pk.EV_SPE, ["spc"] = g.EV_SPC };
        }
        else
        {
            o["ivs"] = new JsonObject { ["hp"] = pk.IV_HP, ["atk"] = pk.IV_ATK, ["def"] = pk.IV_DEF, ["spa"] = pk.IV_SPA, ["spd"] = pk.IV_SPD, ["spe"] = pk.IV_SPE };
            o["evs"] = new JsonObject { ["hp"] = pk.EV_HP, ["atk"] = pk.EV_ATK, ["def"] = pk.EV_DEF, ["spa"] = pk.EV_SPA, ["spd"] = pk.EV_SPD, ["spe"] = pk.EV_SPE };
        }

        o["nature"] = gb ? null : (int)pk.Nature;
        o["natureName"] = gb ? null : pk.Nature.ToString();
        o["ability"] = gb ? null : pk.Ability;
        o["abilityName"] = gb ? null : Name(Names.Ability, pk.Ability);
        o["abilityNumber"] = gb ? null : AbilityIndex(pk);
        o["heldItem"] = gen == 1 ? null : pk.HeldItem;
        o["heldItemName"] = gen == 1 || pk.HeldItem == 0 ? null : Name(Names.GetItemStrings(pk.Context, pk.Version), pk.HeldItem);
        o["gender"] = pk.Gender;
        o["isShiny"] = pk.IsShiny;
        o["pid"] = gb ? null : pk.PID;
        o["ot"] = new JsonObject
        {
            ["name"] = pk.OriginalTrainerName,
            ["tid"] = pk.TID16,
            ["sid"] = gb ? null : pk.SID16,
            ["gender"] = gen == 1 ? null : pk.OriginalTrainerGender,
        };

        o["met"] = gen switch
        {
            1 => null,
            2 => new JsonObject
            {
                ["location"] = pk.MetLocation,
                ["level"] = pk.MetLevel,
                ["timeOfDay"] = ((PK2)pk).MetTimeOfDay,
                ["ball"] = null,
                ["version"] = null,
                ["date"] = null,
            },
            _ => new JsonObject
            {
                ["location"] = pk.MetLocation,
                ["locationName"] = LocationName(pk, false, pk.MetLocation),
                ["level"] = pk.MetLevel,
                ["ball"] = pk.Ball,
                ["version"] = (int)pk.Version,
                ["versionName"] = pk.Version.ToString(),
                ["date"] = gen >= 4 ? Date(pk.MetYear, pk.MetMonth, pk.MetDay) : null,
            },
        };
        o["egg"] = gen >= 4
            ? new JsonObject { ["location"] = pk.EggLocation, ["locationName"] = pk.EggLocation == 0 ? null : LocationName(pk, true, pk.EggLocation), ["date"] = Date(pk.EggYear, pk.EggMonth, pk.EggDay) }
            : null;

        o["friendship"] = gen == 1 ? null : pk.CurrentFriendship;
        o["language"] = pk.Language;
        o["languageCode"] = Util.LangCode(pk.Language);
        o["pokerus"] = gen == 1 ? null : new JsonObject { ["strain"] = pk.PokerusStrain, ["days"] = pk.PokerusDays };
        o["markings"] = pk is IAppliedMarkings && !gb ? MarkingValue(pk) : null;
        o["markingsRaw"] = gb ? null : pk.Data[gen == 3 ? 0x1B : 0x16];
        o["fatefulEncounter"] = gb ? null : pk.FatefulEncounter;

        if (pk is IContestStatsReadOnly cs && !gb)
            o["contest"] = new JsonObject { ["cool"] = cs.ContestCool, ["beauty"] = cs.ContestBeauty, ["cute"] = cs.ContestCute, ["smart"] = cs.ContestSmart, ["tough"] = cs.ContestTough, ["sheen"] = cs.ContestSheen };

        var ribbons = Ribbons(pk);
        o["ribbonCount"] = ribbons.Count;
        o["ribbons"] = ribbons.ToJsonArray();

        o["checksumValid"] = pk.ChecksumValid;
        o["checksum"] = gen switch
        {
            3 => ((PK3)pk).Checksum,
            4 => ((PK4)pk).Checksum,
            5 => ((PK5)pk).Checksum,
            _ => null,
        };

        o["extra"] = Extra(pk);

        if (party || pk.Stat_HPMax != 0)
        {
            o["partyStats"] = new JsonObject
            {
                ["level"] = pk.Stat_Level,
                ["status"] = pk.Status_Condition,
                ["hpCurrent"] = pk.Stat_HPCurrent,
                ["hpMax"] = pk.Stat_HPMax,
                ["atk"] = pk.Stat_ATK,
                ["def"] = pk.Stat_DEF,
                ["spa"] = pk.Stat_SPA,
                ["spd"] = pk.Stat_SPD,
                ["spe"] = pk.Stat_SPE,
            };
        }

        AddHex(o, pk, raw, party);
        return o;
    }

    /// <summary>Short description of a Gen 6+ entity (only produced by PKHeX's Virtual Console path).</summary>
    public static JsonObject MonSummary(PKM pk) => new()
    {
        ["format"] = $"pk{pk.Format}",
        ["species"] = pk.Species,
        ["speciesName"] = SpeciesName.GetSpeciesName(pk.Species, (int)LanguageID.English),
        ["form"] = pk.Form,
        ["nickname"] = pk.Nickname,
        ["isNicknamed"] = pk.IsNicknamed,
        ["level"] = pk.CurrentLevel,
        ["exp"] = pk.EXP,
        ["moves"] = new int[] { pk.Move1, pk.Move2, pk.Move3, pk.Move4 }.ToJsonArray(),
        ["nature"] = (int)pk.Nature,
        ["ability"] = pk.Ability,
        ["gender"] = pk.Gender,
        ["isShiny"] = pk.IsShiny,
        ["ot"] = new JsonObject { ["name"] = pk.OriginalTrainerName, ["tid"] = pk.TID16, ["sid"] = pk.SID16, ["gender"] = pk.OriginalTrainerGender },
        ["met"] = new JsonObject { ["location"] = pk.MetLocation, ["level"] = pk.MetLevel, ["ball"] = pk.Ball, ["version"] = (int)pk.Version, ["versionName"] = pk.Version.ToString() },
        ["language"] = pk.Language,
        ["randomFields"] = new JsonArray("pid", "encryptionConstant", "ivs", "metDate"),
    };

    private static void AddHex(JsonObject o, PKM pk, RawSlot? raw, bool party)
    {
        byte gen = pk.Format;
        if (gen <= 2)
        {
            int boxSize = pk.SIZE_STORED;
            byte[] body;
            byte[] ot;
            byte[] nick;
            if (raw is not null)
            {
                body = raw.Body;
                ot = raw.OtName!;
                nick = raw.Nickname!;
            }
            else
            {
                body = pk.Data.AsSpan(0, party ? pk.SIZE_PARTY : boxSize).ToArray();
                ot = pk.OriginalTrainerTrash.ToArray();
                nick = pk.NicknameTrash.ToArray();
            }
            var boxStruct = body.AsSpan(0, boxSize);
            o["storedHex"] = Util.Hex(body);
            o["decryptedHex"] = Util.Hex(body);
            o["structHex"] = Util.Hex(boxStruct);
            if (body.Length > boxSize)
                o["partyStructHex"] = Util.Hex(body);
            o["otNameHex"] = Util.Hex(ot);
            o["nicknameHex"] = Util.Hex(nick);
            // pk2 records start with the species-list entry (0xFD marks an Egg; docs/ARCHITECTURE.md).
            o["recordHex"] = pk.Format == 2
                ? Util.Hex([(byte)(raw?.ListSpecies ?? (pk.IsEgg ? 0xFD : pk.Species)), .. boxStruct, .. ot, .. nick])
                : Util.Hex([.. boxStruct, .. ot, .. nick]);
            o["listSpecies"] = raw?.ListSpecies;
            return;
        }

        byte[] stored = raw?.Body ?? (party ? pk.EncryptedPartyData : pk.EncryptedBoxData);
        byte[] decrypted = gen == 3 ? PokeCrypto.DecryptArray3(stored.ToArray()) : PokeCrypto.DecryptArray45(stored.ToArray());
        o["storedHex"] = Util.Hex(stored);
        o["decryptedHex"] = Util.Hex(decrypted);
        o["recordHex"] = Util.Hex(stored.AsSpan(0, pk.SIZE_STORED));
        o["shuffleOrder"] = gen == 3 ? (int)(pk.PID % 24) : (int)(((pk.PID >> 13) & 31) % 24);
    }

    private static string? LocationName(PKM pk, bool egg, ushort location)
    {
        try
        {
            var s = Names.GetLocationName(egg, location, pk.Format, pk.Generation, pk.Version);
            return string.IsNullOrEmpty(s) ? null : s;
        }
        catch (Exception)
        {
            return null;
        }
    }

    private static string? Date(byte y, byte m, byte d) => y == 0 && m == 0 && d == 0 ? null : $"{2000 + y:0000}-{m:00}-{d:00}";

    /// <summary>0, 1 or 2 (2 = hidden ability, Gen 5). PKHeX itself uses the flags 1/2/4.</summary>
    public static int AbilityIndex(PKM pk) => pk.AbilityNumber switch
    {
        1 => 0,
        2 => 1,
        4 => 2,
        _ => -1,
    };

    private static int MarkingValue(PKM pk) => pk switch
    {
        PK3 p => p.MarkingValue,
        PK4 p => p.MarkingValue,
        PK5 p => p.MarkingValue,
        _ => 0,
    };

    public static List<string> Ribbons(PKM pk)
    {
        var list = new List<string>();
        foreach (var r in RibbonInfo.GetRibbonInfo(pk))
        {
            if (r.Type == RibbonValueType.Byte)
            {
                if (r.RibbonCount > 0)
                    list.Add($"{r.Name}={r.RibbonCount}");
            }
            else if (r.HasRibbon)
            {
                list.Add(r.Name);
            }
        }
        list.Sort(StringComparer.Ordinal);
        return list;
    }

    private static JsonObject? Extra(PKM pk) => pk switch
    {
        PK1 p => new JsonObject
        {
            ["catchRate"] = p.CatchRate,
            ["type1"] = p.Type1,
            ["type2"] = p.Type2,
            ["boxLevel"] = p.Stat_LevelBox,
            ["speciesInternal"] = p.SpeciesInternal,
        },
        PK2 p => new JsonObject
        {
            ["caughtData"] = p.CaughtData,
            ["korean"] = p.Korean,
        },
        PK3 p => new JsonObject
        {
            ["abilityBit"] = p.AbilityBit,
            ["speciesInternal"] = p.SpeciesInternal,
            ["flagIsBadEgg"] = p.FlagIsBadEgg,
            ["flagHasSpecies"] = p.FlagHasSpecies,
            ["flagIsEgg"] = p.FlagIsEgg,
        },
        PK4 p => new JsonObject
        {
            ["metLocationDP"] = p.MetLocationDP,
            ["metLocationExtended"] = p.MetLocationExtended,
            ["eggLocationDP"] = p.EggLocationDP,
            ["eggLocationExtended"] = p.EggLocationExtended,
            ["ballDPPt"] = p.BallDPPt,
            ["ballHGSS"] = p.BallHGSS,
            ["groundTile"] = (int)p.GroundTile,
            ["shinyLeaf"] = p.ShinyLeaf,
            ["pokeathlonStat"] = p.PokeathlonStat,
        },
        PK5 p => new JsonObject
        {
            ["hiddenAbility"] = p.HiddenAbility,
            ["nSparkle"] = p.NSparkle,
            ["pokeStarFame"] = p.PokeStarFame,
            ["groundTile"] = (int)p.GroundTile,
        },
        _ => null,
    };

    // ------------------------------------------------------------------ saves

    public static SaveFile LoadSave(string path)
    {
        if (!File.Exists(path))
            throw new OracleException($"file not found: {path}");
        var data = File.ReadAllBytes(path);
        var sav = SaveUtil.GetVariantSAV(data, path) ?? throw new OracleException($"PKHeX does not recognise {path} ({data.Length} bytes) as a save file");
        return sav;
    }

    public static JsonObject Save(SaveFile sav, string? path = null)
    {
        var o = new JsonObject
        {
            ["oracle"] = new JsonObject { ["tool"] = "pkhex-oracle", ["pkhexCore"] = Util.PkhexVersion },
        };
        if (path is not null)
        {
            var bytes = File.ReadAllBytes(path);
            o["file"] = new JsonObject { ["name"] = Path.GetFileName(path), ["size"] = bytes.Length, ["sha256"] = Util.Sha256(bytes) };
        }

        byte gen = sav.Generation;
        o["saveType"] = sav.GetType().Name;
        o["version"] = sav.Version.ToString();
        o["versionId"] = (int)sav.Version;
        o["generation"] = gen;
        o["format"] = Util.FormatName(gen);
        o["language"] = sav.Language;
        o["languageCode"] = Util.LangCode(sav.Language);
        o["japanese"] = sav is ILangDeviantSave l1 && l1.Japanese;
        o["korean"] = sav is ILangDeviantSave l2 && l2.Korean;
        o["checksumsValid"] = sav.ChecksumsValid;
        o["checksumInfo"] = sav.ChecksumInfo;
        o["trainer"] = new JsonObject
        {
            ["name"] = sav.OT,
            ["tid"] = sav.TID16,
            ["sid"] = gen <= 2 ? null : sav.SID16,
            ["gender"] = gen == 1 || (gen == 2 && sav.Version != GameVersion.C) ? null : sav.Gender,
            ["money"] = sav.Money,
            ["playTime"] = new JsonObject { ["h"] = sav.PlayedHours, ["m"] = sav.PlayedMinutes, ["s"] = sav.PlayedSeconds },
        };

        o["currentBox"] = sav.CurrentBox;
        o["boxCount"] = sav.BoxCount;
        o["boxSlotCount"] = sav.BoxSlotCount;
        var names = new JsonArray();
        for (int b = 0; b < sav.BoxCount; b++)
            names.Add(sav is IBoxDetailNameRead r ? r.GetBoxName(b) : null);
        o["boxNames"] = names;

        if (gen <= 2)
            o["gb"] = GbInfo(sav);

        o["partyCount"] = sav.PartyCount;
        var party = new JsonArray();
        for (int i = 0; i < sav.PartyCount; i++)
        {
            var pk = sav.GetPartySlotAtIndex(i);
            var mon = new JsonObject { ["slot"] = i };
            foreach (var kv in Mon(pk, Raw.GetPartySlot(sav, i), party: true).ToList())
                mon[kv.Key] = kv.Value?.DeepClone();
            party.Add(mon);
        }
        o["party"] = party;

        var boxes = new JsonArray();
        for (int b = 0; b < sav.BoxCount; b++)
        {
            for (int s = 0; s < sav.BoxSlotCount; s++)
            {
                var pk = sav.GetBoxSlotAtIndex(b, s);
                if (pk.Species == 0)
                    continue;
                var mon = new JsonObject { ["box"] = b, ["slot"] = s };
                foreach (var kv in Mon(pk, Raw.GetBoxSlot(sav, b, s)).ToList())
                    mon[kv.Key] = kv.Value?.DeepClone();
                boxes.Add(mon);
            }
        }
        o["boxSlotsUsed"] = boxes.Count;
        o["boxes"] = boxes;

        var seen = new List<int>();
        var caught = new List<int>();
        if (sav.HasPokeDex)
        {
            for (ushort sp = 1; sp <= sav.MaxSpeciesID; sp++)
            {
                if (sav.GetSeen(sp))
                    seen.Add(sp);
                if (sav.GetCaught(sp))
                    caught.Add(sp);
            }
        }
        o["pokedex"] = new JsonObject { ["seen"] = seen.ToJsonArray(), ["caught"] = caught.ToJsonArray() };
        return o;
    }

    /// <summary>Raw list headers and the current-box mirror state for Gen 1/2 saves.</summary>
    private static JsonObject GbInfo(SaveFile sav)
    {
        var offsets = new List<int>();
        var counts = new List<int>();
        var headers = new List<string>();
        for (int b = 0; b < sav.BoxCount; b++)
        {
            int ofs = Raw.BoxListOffset(sav, b);
            var (count, header) = Raw.ListHeader(sav, ofs, sav.BoxSlotCount);
            offsets.Add(ofs);
            counts.Add(count);
            headers.Add(Util.Hex(header));
        }
        int pofs = Raw.PartyListOffset(sav);
        var (pcount, pheader) = Raw.ListHeader(sav, pofs, 6);

        int cur = Raw.CurrentBoxCopyOffset(sav);
        int len = Raw.BoxListLength(sav);
        bool? mirror = null;
        if (sav.CurrentBox < sav.BoxCount)
            mirror = sav.Data.AsSpan(cur, len).SequenceEqual(sav.Data.AsSpan(Raw.BankBoxListOffset(sav, sav.CurrentBox), len));

        var o = new JsonObject
        {
            ["partyList"] = new JsonObject { ["offset"] = pofs, ["count"] = pcount, ["speciesHex"] = Util.Hex(pheader) },
            ["boxListOffsets"] = offsets.ToJsonArray(),
            ["boxListCounts"] = counts.ToJsonArray(),
            ["boxListSpeciesHex"] = headers.ToJsonArray(),
            ["currentBoxCopyOffset"] = cur,
            ["currentBoxCopyMatchesBank"] = mirror,
        };
        if (sav is SAV1)
            o["boxesInitialized"] = (sav.Data[Raw.OffsetValue(sav, "CurrentBoxIndex")] & 0x80) != 0;
        return o;
    }
}
