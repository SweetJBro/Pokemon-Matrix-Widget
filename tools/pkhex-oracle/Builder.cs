using System.Reflection;
using System.Text.Json.Nodes;
using PKHeX.Core;

namespace PkhexOracle;

/// <summary>Trainer defaults used when a Pokémon spec omits OT fields.</summary>
internal sealed record TrainerDefaults(string Name, ushort Tid, ushort Sid, byte Gender, int Language, GameVersion Origin);

/// <summary>
/// Builds saves and entities from JSON specs. Everything is deterministic: PIDs are found by a
/// seeded search, Gen 1/2 DVs by a fixed-order search, and no PKHeX helper that draws from
/// <c>Util.Rand</c> is used.
/// </summary>
internal static class Builder
{
    // ------------------------------------------------------------------ save

    public static (SaveFile Sav, List<string> Warnings, List<string> Notes) BuildSave(JsonObject spec)
    {
        var warnings = new List<string>();
        var game = Util.ParseGame(spec.Str("game") ?? throw new OracleException("spec.game is required"));
        var lang = Util.ParseLang(spec.Str("lang") ?? "en");
        var tr = spec.Obj("trainer") ?? new JsonObject();
        var name = tr.Str("name") ?? DefaultTrainerName(lang);

        void Init(SaveFile s)
        {
            ApplyTrainer(s, tr, warnings);
            if (spec.Obj("gen1") is { } g1)
            {
                if (s is not SAV1 s1)
                    throw new OracleException("spec.gen1 is only valid for Gen 1 games");
                if (g1.Int("starter") is { } st)
                    s1.Starter = SpeciesConverter.GetInternal1((byte)st);
                if (g1.Int("rivalStarter") is { } rs)
                    s1.RivalStarter = SpeciesConverter.GetInternal1((byte)rs);
                if (g1.Int("pikachuFriendship") is { } pf)
                    s1.PikaFriendship = (byte)pf;
            }
        }
        var (sav, notes) = Skeleton.Create(game, lang, name, spec, Init);

        bool registerDex = spec.Bool("registerDex") ?? true;
        var origin = OriginGame(game);
        var defaults = new TrainerDefaults(sav.OT, sav.TID16, sav.SID16, sav.Generation >= 2 ? sav.Gender : (byte)0, (int)lang, origin);
        var monDefaults = spec.Obj("defaults") ?? new JsonObject();

        if (spec.Arr("party") is { } party)
        {
            if (party.Count > 6)
                throw new OracleException("party has more than 6 Pokémon");
            for (int i = 0; i < party.Count; i++)
            {
                var ms = Merge(monDefaults, party[i] as JsonObject ?? throw new OracleException($"party[{i}] must be an object"));
                var pk = BuildMon(sav, ms, defaults, $"party:{i}", party: true);
                sav.SetPartySlotAtIndex(pk, i, PKMImportSetting.Skip, DexSetting(ms, registerDex));
            }
        }

        var placements = new List<(int Box, int Slot, JsonObject Spec)>();
        if (spec.Arr("boxes") is { } boxes)
        {
            foreach (var node in boxes)
            {
                var ms = node as JsonObject ?? throw new OracleException("boxes[] entries must be objects");
                int b = ms.Int("box") ?? throw new OracleException("boxes[] entry needs 'box'");
                int s = ms.Int("slot") ?? throw new OracleException("boxes[] entry needs 'slot'");
                placements.Add((b, s, Merge(monDefaults, ms)));
            }
        }
        if (spec.Arr("fill") is { } fills)
        {
            foreach (var node in fills)
                placements.AddRange(ExpandFill(node as JsonObject ?? throw new OracleException("fill[] entries must be objects"), monDefaults));
        }

        if (sav.Generation <= 2)
            CheckPacked(sav, placements, warnings);

        foreach (var (b, s, ms) in placements)
        {
            if ((uint)b >= sav.BoxCount || (uint)s >= sav.BoxSlotCount)
                throw new OracleException($"box {b} slot {s} is outside {sav.BoxCount} boxes x {sav.BoxSlotCount} slots");
            var pk = BuildMon(sav, ms, defaults, $"box:{b}:{s}", party: false);
            sav.SetBoxSlotAtIndex(pk, b, s, PKMImportSetting.Skip, DexSetting(ms, registerDex));
        }

        if (spec.Arr("boxNames") is { } bn)
        {
            if (sav is not IBoxDetailName names)
                throw new OracleException("this save type has no editable box names");
            for (int i = 0; i < bn.Count; i++)
            {
                if (bn[i] is JsonValue v && v.TryGetValue<string>(out var n))
                    names.SetBoxName(i, n);
            }
        }

        if (spec.Arr("dexSeen") is { } extraSeen)
        {
            foreach (var sp in extraSeen.Ints())
                sav.SetSeen((ushort)sp, true);
        }
        if (spec.Arr("dexCaught") is { } extraCaught)
        {
            foreach (var sp in extraCaught.Ints())
            {
                sav.SetSeen((ushort)sp, true);
                sav.SetCaught((ushort)sp, true);
            }
        }

        if (spec.Int("currentBox") is { } cb)
            sav.CurrentBox = cb;

        return (sav, warnings, notes);
    }

    private static PKMImportSetting DexSetting(JsonObject ms, bool registerDex) =>
        (ms.Bool("registerDex") ?? registerDex) ? PKMImportSetting.Update : PKMImportSetting.Skip;

    private static JsonObject Merge(JsonObject defaults, JsonObject spec)
    {
        var o = new JsonObject();
        foreach (var kv in defaults)
            o[kv.Key] = kv.Value?.DeepClone();
        foreach (var kv in spec)
            o[kv.Key] = kv.Value?.DeepClone();
        return o;
    }

    private static IEnumerable<(int, int, JsonObject)> ExpandFill(JsonObject f, JsonObject monDefaults)
    {
        int box = f.Int("box") ?? throw new OracleException("fill entry needs 'box'");
        int start = f.Int("start") ?? 0;
        int count = f.Int("count") ?? throw new OracleException("fill entry needs 'count'");
        var template = Merge(monDefaults, f.Obj("template") ?? new JsonObject());
        int[]? species = f.Arr("species")?.Ints();
        int? speciesStart = f.Int("speciesStart");
        bool orders = f.Bool("shuffleOrders") ?? false;
        int levelStep = f.Int("levelStep") ?? 0;
        for (int i = 0; i < count; i++)
        {
            var ms = (JsonObject)template.DeepClone();
            if (species is not null)
                ms["species"] = species[i % species.Length];
            else if (speciesStart is not null)
                ms["species"] = speciesStart + i;
            if (orders)
                ms["shuffleOrder"] = i % 24;
            if (levelStep != 0)
                ms["level"] = (ms.Int("level") ?? 5) + (i * levelStep);
            yield return (box, start + i, ms);
        }
    }

    /// <summary>Gen 1/2 box lists are packed: PKHeX compacts gaps on write.</summary>
    private static void CheckPacked(SaveFile sav, List<(int Box, int Slot, JsonObject Spec)> placements, List<string> warnings)
    {
        foreach (var grp in placements.GroupBy(p => p.Box))
        {
            var slots = grp.Select(p => p.Slot).OrderBy(x => x).ToArray();
            for (int i = 0; i < slots.Length; i++)
            {
                if (slots[i] != i)
                {
                    warnings.Add($"box {grp.Key}: Gen {sav.Generation} lists are packed; slots {string.Join(",", slots)} will be compacted to 0..{slots.Length - 1}");
                    break;
                }
            }
        }
    }

    private static void ApplyTrainer(SaveFile sav, JsonObject tr, List<string> warnings)
    {
        if (tr.Str("name") is { } n)
            sav.OT = n;
        if (tr.Int("tid") is { } tid)
            sav.TID16 = (ushort)tid;
        if (tr.Int("sid") is { } sid)
        {
            if (sav.Generation >= 3)
                sav.SID16 = (ushort)sid;
            else if (sid != 0)
                warnings.Add("trainer.sid ignored: Gen 1/2 have no secret ID");
        }
        if (tr.Int("gender") is { } g)
        {
            if (sav.Generation >= 3 || sav.Version == GameVersion.C)
                sav.Gender = (byte)g;
            else if (g != 0)
                warnings.Add("trainer.gender ignored: only Crystal and Gen 3+ store a player gender");
        }
        if (tr.UInt("money") is { } money)
            sav.Money = money;
        if (tr.Obj("playTime") is { } pt)
        {
            sav.PlayedHours = pt.Int("h") ?? 0;
            sav.PlayedMinutes = pt.Int("m") ?? 0;
            sav.PlayedSeconds = pt.Int("s") ?? 0;
        }
    }

    public static string DefaultTrainerName(LanguageID lang) => lang switch
    {
        LanguageID.Japanese => "テスト",
        LanguageID.Korean => "테스트",
        _ => "PKHeX",
    };

    /// <summary>The single game written into a Pokémon's origin field for a save of this version.</summary>
    public static GameVersion OriginGame(GameVersion game) => game switch
    {
        GameVersion.RS => GameVersion.R,
        GameVersion.FRLG => GameVersion.FR,
        GameVersion.DP => GameVersion.D,
        GameVersion.HGSS => GameVersion.HG,
        GameVersion.BW => GameVersion.B,
        GameVersion.B2W2 => GameVersion.B2,
        GameVersion.GS => GameVersion.GD,
        GameVersion.RBY or GameVersion.RB => GameVersion.RD,
        _ => game,
    };

    // ------------------------------------------------------------------ entity

    public static PKM BuildMon(SaveFile sav, JsonObject ms, TrainerDefaults tr, string key, bool party)
    {
        var pk = sav.BlankPKM;
        bool korean = sav is ILangDeviantSave { Korean: true };
        int language = ms.Has("language") ? LangValue(ms["language"]!) : tr.Language;
        var origin = ms.Str("metVersion") is { } mv ? Util.ParseGame(mv) : tr.Origin;
        return pk.Format <= 2
            ? BuildGB(sav, (GBPKM)pk, ms, tr, korean, key, party)
            : Build345(pk, ms, tr, language, origin, key, party);
    }

    private static bool HasSecondAbility(PersonalInfo pi) =>
        pi is IPersonalAbility12 a && a.Ability2 != 0 && a.Ability1 != a.Ability2;

    private static int LangValue(JsonNode n) =>
        n is JsonValue v && v.TryGetValue<int>(out var i) ? i : (int)Util.ParseLang(n.GetValue<string>());

    private static ushort Species(JsonObject ms) => (ushort)(ms.Int("species") ?? throw new OracleException("Pokémon spec needs 'species'"));

    private static int[] Pad4(int[]? a, int fill = 0)
    {
        var r = new[] { fill, fill, fill, fill };
        if (a is not null)
        {
            if (a.Length > 4)
                throw new OracleException("at most 4 moves / ppUps / pp");
            Array.Copy(a, r, a.Length);
        }
        return r;
    }

    private static void SetMoves(PKM pk, JsonObject ms)
    {
        var moves = Pad4(ms.Arr("moves")?.Ints() ?? [33]);
        foreach (var m in moves)
        {
            if ((uint)m > pk.MaxMoveID)
                throw new OracleException($"move {m} does not exist in Gen {pk.Format} (max {pk.MaxMoveID})");
        }
        var ups = Pad4(ms.Arr("ppUps")?.Ints());
        pk.Move1 = (ushort)moves[0];
        pk.Move2 = (ushort)moves[1];
        pk.Move3 = (ushort)moves[2];
        pk.Move4 = (ushort)moves[3];
        pk.Move1_PPUps = moves[0] == 0 ? 0 : ups[0];
        pk.Move2_PPUps = moves[1] == 0 ? 0 : ups[1];
        pk.Move3_PPUps = moves[2] == 0 ? 0 : ups[2];
        pk.Move4_PPUps = moves[3] == 0 ? 0 : ups[3];
        pk.HealPP();
        if (ms.Arr("pp")?.Ints() is { } pp)
        {
            var p = Pad4(pp);
            pk.Move1_PP = p[0];
            pk.Move2_PP = p[1];
            pk.Move3_PP = p[2];
            pk.Move4_PP = p[3];
        }
    }

    private static void SetRibbons(PKM pk, JsonObject ms)
    {
        var node = ms["ribbons"];
        if (node is null)
            return;
        void Set(string name, object value)
        {
            var p = pk.GetType().GetProperty(name, BindingFlags.Public | BindingFlags.Instance)
                ?? throw new OracleException($"{pk.GetType().Name} has no ribbon property '{name}'");
            p.SetValue(pk, Convert.ChangeType(value, p.PropertyType));
        }
        switch (node)
        {
            case JsonArray a:
                foreach (var r in a)
                    Set(r!.GetValue<string>(), true);
                break;
            case JsonObject o:
                foreach (var kv in o)
                {
                    if (kv.Value is JsonValue v && v.TryGetValue<bool>(out var b))
                        Set(kv.Key, b);
                    else
                        Set(kv.Key, kv.Value!.GetValue<int>());
                }
                break;
        }
    }

    // ----------------------------------------------------------- Gen 1 / 2

    private static PKM BuildGB(SaveFile sav, GBPKM pk, JsonObject ms, TrainerDefaults tr, bool korean, string key, bool party)
    {
        var species = Species(ms);
        if (species > sav.MaxSpeciesID)
            throw new OracleException($"{key}: species {species} does not exist in Gen {sav.Generation}");
        pk.Species = species;
        bool isEgg = ms.Bool("isEgg") ?? false;
        if (isEgg && pk is not PK2)
            throw new OracleException($"{key}: Gen 1 has no eggs");

        // OT first: for PK2 the Korean flag is derived from the OT name bytes.
        pk.TID16 = (ushort)(ms.Int("tid") ?? tr.Tid);
        var otName = ms.Str("otName") ?? tr.Name;
        if (korean)
            StringConverter2KOR.SetString(pk.OriginalTrainerTrash, otName, pk.MaxStringLengthTrainer, StringConverterOption.Clear50);
        else
            pk.OriginalTrainerName = otName;

        // DVs (shiny, gender and Unown letter are all derived from them).
        pk.DV16 = ChooseDVs(pk, ms, key);

        // Stat experience.
        var se = ms.Obj("statExp") ?? ms.Obj("evs");
        if (se is not null)
        {
            pk.EV_HP = se.Int("hp") ?? 0;
            pk.EV_ATK = se.Int("atk") ?? 0;
            pk.EV_DEF = se.Int("def") ?? 0;
            pk.EV_SPE = se.Int("spe") ?? 0;
            pk.EV_SPC = se.Int("spc") ?? se.Int("spa") ?? 0;
        }

        int level = ms.Int("level") ?? 5;
        pk.CurrentLevel = (byte)level;
        if (ms.UInt("exp") is { } exp)
            pk.EXP = exp;
        SetMoves(pk, ms);

        if (pk is PK1 p1)
        {
            var personal = sav.Version == GameVersion.YW ? PersonalTable.Y : PersonalTable.RB;
            p1.CatchRate = (byte)(ms.Int("catchRate") ?? personal[species].CatchRate);
            if (ms.Int("heldItem") is { } hi && hi != 0)
                throw new OracleException($"{key}: Gen 1 cannot hold items (use catchRate)");
        }
        else if (pk is PK2 p2)
        {
            p2.HeldItem = ms.Int("heldItem") ?? 0;
            if ((uint)p2.HeldItem > p2.MaxItemID)
                throw new OracleException($"{key}: item {p2.HeldItem} does not exist in Gen 2 (max {p2.MaxItemID})");
            if (ms.Obj("pokerus") is { } pr)
            {
                p2.PokerusStrain = pr.Int("strain") ?? 0;
                p2.PokerusDays = pr.Int("days") ?? 0;
            }
            // Crystal caught data (GS leaves these bytes zero).
            bool crystal = sav.Version == GameVersion.C;
            if (ms.Has("metLevel") || ms.Has("metLocation") || ms.Has("metTimeOfDay") || ms.Has("otGender"))
            {
                p2.MetTimeOfDay = ms.Int("metTimeOfDay") ?? (crystal ? 1 : 0);
                p2.MetLevel = (byte)(ms.Int("metLevel") ?? 0);
                p2.MetLocation = (ushort)(ms.Int("metLocation") ?? 0);
                p2.OriginalTrainerGender = (byte)(ms.Int("otGender") ?? tr.Gender);
            }
            p2.IsEgg = isEgg;
            p2.CurrentFriendship = (byte)(ms.Int("friendship") ?? (isEgg ? p2.PersonalInfo.HatchCycles : p2.PersonalInfo.BaseFriendship));
        }

        // Nickname last: GB "is nicknamed" is derived by comparing against the species name.
        if (isEgg)
        {
            var egg = ms.Str("nickname") ?? SpeciesName.GetEggName(EggLanguage(sav), 2);
            SetGBNickname(pk, egg, korean);
        }
        else if (ms.Str("nickname") is { } nick)
        {
            SetGBNickname(pk, nick, korean);
        }
        else
        {
            pk.SetNotNicknamed(GBLanguage(sav));
        }

        if (party)
            pk.ResetPartyStats();
        return pk;
    }

    private static int GBLanguage(SaveFile sav) => sav is ILangDeviantSave { Japanese: true } ? 1 : sav is ILangDeviantSave { Korean: true } ? 8 : 2;

    private static int EggLanguage(SaveFile sav) => GBLanguage(sav);

    private static void SetGBNickname(GBPKM pk, string nick, bool korean)
    {
        if (korean)
        {
            StringConverter2KOR.SetString(pk.NicknameTrash, nick, pk.MaxStringLengthNickname, StringConverterOption.Clear50);
            return;
        }
        pk.SetString(pk.NicknameTrash, nick, pk.MaxStringLengthNickname, StringConverterOption.Clear50);
    }

    /// <summary>
    /// Explicit DVs are used as given (and checked against shiny/gender/form requests). Otherwise
    /// start from a fixed default and walk all 65536 DV words in order until the requested shiny
    /// state, gender and Unown letter all hold.
    /// </summary>
    private static ushort ChooseDVs(GBPKM pk, JsonObject ms, string key)
    {
        var dv = ms.Obj("dvs") ?? ms.Obj("ivs");
        bool? shiny = ms.Bool("shiny");
        int? gender = GenderValue(ms);
        int form = ms.Int("form") ?? 0;
        bool unown = pk.Species == (int)PKHeX.Core.Species.Unown;
        if (!unown && form != 0)
            throw new OracleException($"{key}: only Unown has forms in Gen 2");

        bool Ok()
        {
            if (shiny is { } s && pk.IsShiny != s)
                return false;
            if (shiny is null && pk.IsShiny)
                return false; // default: not shiny
            if (gender is { } g && pk is PK2 && pk.PersonalInfo.Genderless == false && pk.PersonalInfo.OnlyMale == false && pk.PersonalInfo.OnlyFemale == false && pk.Gender != g)
                return false;
            if (unown && pk is PK2 && pk.Form != form)
                return false;
            return true;
        }

        if (dv is not null)
        {
            int atk = dv.Int("atk") ?? 0, def = dv.Int("def") ?? 0, spe = dv.Int("spe") ?? 0, spc = dv.Int("spc") ?? dv.Int("spa") ?? 0;
            pk.DV16 = (ushort)((atk << 12) | (def << 8) | (spe << 4) | spc);
            if (dv.Int("hp") is { } hp && hp != pk.IV_HP)
                throw new OracleException($"{key}: HP DV {hp} is inconsistent with the other DVs (derived HP DV is {pk.IV_HP})");
            if (!Ok())
                throw new OracleException($"{key}: explicit DVs do not satisfy the requested shiny/gender/form");
            return pk.DV16;
        }

        ushort start = shiny == true ? (ushort)0xAAAA : (ushort)0x9876;
        for (int i = 0; i < 0x10000; i++)
        {
            pk.DV16 = (ushort)(start + i);
            if (Ok())
                return pk.DV16;
        }
        throw new OracleException($"{key}: no DV combination satisfies shiny={shiny} gender={gender} form={form}");
    }

    private static int? GenderValue(JsonObject ms)
    {
        var n = ms["gender"];
        if (n is null)
            return null;
        if (n is JsonValue v && v.TryGetValue<int>(out var i))
            return i;
        return n.GetValue<string>().Trim().ToUpperInvariant() switch
        {
            "M" or "MALE" => 0,
            "F" or "FEMALE" => 1,
            "-" or "N" or "GENDERLESS" => 2,
            var s => throw new OracleException($"bad gender '{s}'"),
        };
    }

    private static int? NatureValue(JsonObject ms)
    {
        var n = ms["nature"];
        if (n is null)
            return null;
        if (n is JsonValue v && v.TryGetValue<int>(out var i))
            return i;
        return (int)Enum.Parse<Nature>(n.GetValue<string>(), true);
    }

    // ----------------------------------------------------------- Gen 3 / 4 / 5

    private static PKM Build345(PKM pk, JsonObject ms, TrainerDefaults tr, int language, GameVersion origin, string key, bool party)
    {
        byte gen = pk.Format;
        var species = Species(ms);
        if (species > pk.MaxSpeciesID)
            throw new OracleException($"{key}: species {species} does not exist in Gen {gen}");
        byte form = (byte)(ms.Int("form") ?? 0);
        bool isEgg = ms.Bool("isEgg") ?? false;

        pk.Species = species;
        if (gen >= 4)
            pk.Form = form;
        pk.Language = language;
        pk.Version = origin; // before met location / ball: PK4 setters depend on the origin game
        pk.TID16 = (ushort)(ms.Int("tid") ?? tr.Tid);
        pk.SID16 = (ushort)(ms.Int("sid") ?? tr.Sid);
        pk.OriginalTrainerName = ms.Str("otName") ?? tr.Name;
        pk.OriginalTrainerGender = (byte)(ms.Int("otGender") ?? tr.Gender);

        var pi = pk.PersonalInfo; // form-aware in Gen 4/5
        int? abilityIndex = ms.Int("abilityNumber");
        if (abilityIndex is 2 && gen != 5)
            throw new OracleException($"{key}: hidden abilities (abilityNumber 2) exist only in Gen 5");

        var c = new PidConstraints(
            gen,
            species,
            form,
            pi.Gender,
            NatureValue(ms),
            GenderValue(ms),
            abilityIndex is 0 or 1 ? abilityIndex : null,
            ms.Bool("shiny") ?? false,
            ms.Int("shuffleOrder"),
            pk.TID16,
            pk.SID16);
        uint pid = ms.UInt("pid") ?? Pid.Find(c, Util.Fnv(key + ":" + species) ^ (ms.UInt("pidSeed") ?? 0));
        pk.PID = pid;
        if (gen == 3 && species == (int)PKHeX.Core.Species.Unown && EntityPID.GetUnownForm3(pid) != form)
            throw new OracleException($"{key}: PID {pid:X8} gives Unown form {EntityPID.GetUnownForm3(pid)}, not {form}");

        int pidAbility = gen == 5 ? (int)((pid >> 16) & 1) : (int)(pid & 1);
        int slot = abilityIndex ?? pidAbility;
        if (slot == 1 && !HasSecondAbility(pi))
            slot = 0;
        switch (pk)
        {
            case PK3 p3:
                p3.AbilityBit = slot == 1;
                break;
            case PK4 p4:
                p4.Ability = pi.GetAbilityAtIndex(slot);
                p4.Gender = EntityGender.GetFromPIDAndRatio(pid, pi.Gender);
                break;
            case PK5 p5:
                p5.HiddenAbility = slot == 2;
                p5.Ability = pi.GetAbilityAtIndex(slot);
                p5.Gender = EntityGender.GetFromPIDAndRatio(pid, pi.Gender);
                p5.Nature = (Nature)(NatureValue(ms) ?? (int)(pid % 25));
                break;
        }

        int level = ms.Int("level") ?? (isEgg ? EggStateLegality.GetEggLevel(gen) : 5);
        pk.CurrentLevel = (byte)level;
        if (ms.UInt("exp") is { } exp)
            pk.EXP = exp;
        SetMoves(pk, ms);

        var iv = ms.Obj("ivs");
        pk.IV_HP = iv?.Int("hp") ?? 1;
        pk.IV_ATK = iv?.Int("atk") ?? 2;
        pk.IV_DEF = iv?.Int("def") ?? 3;
        pk.IV_SPA = iv?.Int("spa") ?? 4;
        pk.IV_SPD = iv?.Int("spd") ?? 5;
        pk.IV_SPE = iv?.Int("spe") ?? 6;
        var ev = ms.Obj("evs");
        pk.EV_HP = ev?.Int("hp") ?? 0;
        pk.EV_ATK = ev?.Int("atk") ?? 0;
        pk.EV_DEF = ev?.Int("def") ?? 0;
        pk.EV_SPA = ev?.Int("spa") ?? 0;
        pk.EV_SPD = ev?.Int("spd") ?? 0;
        pk.EV_SPE = ev?.Int("spe") ?? 0;
        if (ms.Obj("contest") is { } ct && pk is IContestStats cs)
        {
            cs.ContestCool = (byte)(ct.Int("cool") ?? 0);
            cs.ContestBeauty = (byte)(ct.Int("beauty") ?? 0);
            cs.ContestCute = (byte)(ct.Int("cute") ?? 0);
            cs.ContestSmart = (byte)(ct.Int("smart") ?? 0);
            cs.ContestTough = (byte)(ct.Int("tough") ?? 0);
            cs.ContestSheen = (byte)(ct.Int("sheen") ?? 0);
        }

        pk.HeldItem = ms.Int("heldItem") ?? 0;
        if ((uint)pk.HeldItem > pk.MaxItemID)
            throw new OracleException($"{key}: item {pk.HeldItem} does not exist in Gen {gen} (max {pk.MaxItemID})");
        pk.FatefulEncounter = ms.Bool("fatefulEncounter") ?? false;
        pk.MetLocation = (ushort)(ms.Int("metLocation") ?? 0);
        pk.MetLevel = (byte)(ms.Int("metLevel") ?? (isEgg ? (gen == 5 ? 1 : 0) : level));
        pk.Ball = (byte)(ms.Int("ball") ?? 4);
        if (gen >= 4)
        {
            var met = Util.ParseDate(ms.Str("metDate") ?? (isEgg ? ms.Str("eggDate") : null) ?? "2010-01-01");
            pk.MetYear = (byte)(met.Year - 2000);
            pk.MetMonth = (byte)met.Month;
            pk.MetDay = (byte)met.Day;
            if (ms.Int("eggLocation") is { } el)
            {
                pk.EggLocation = (ushort)el;
                var ed = Util.ParseDate(ms.Str("eggDate") ?? ms.Str("metDate") ?? "2010-01-01");
                pk.EggYear = (byte)(ed.Year - 2000);
                pk.EggMonth = (byte)ed.Month;
                pk.EggDay = (byte)ed.Day;
            }
            if (pk is IGroundTile gt && ms.Int("groundTile") is { } tile)
                gt.GroundTile = (GroundTileType)tile;
        }
        else if (ms.Has("eggLocation"))
        {
            throw new OracleException($"{key}: Gen 3 has no egg location field");
        }

        pk.CurrentFriendship = (byte)(ms.Int("friendship") ?? (isEgg ? pi.HatchCycles : pi.BaseFriendship));
        if (ms.Obj("pokerus") is { } pr)
        {
            pk.PokerusStrain = pr.Int("strain") ?? 0;
            pk.PokerusDays = pr.Int("days") ?? 0;
        }
        if (ms.Int("markings") is { } mk)
        {
            // Raw marking byte as stored (Gen 3 offset 0x1B, Gen 4/5 offset 0x16). PKHeX's
            // MarkingValue property swaps bits 1 and 2 for PK3, so it is not used here.
            pk.Data[gen == 3 ? 0x1B : 0x16] = (byte)mk;
        }
        if (pk is PK5 p5x)
        {
            if (ms.Bool("nSparkle") is { } ns)
                p5x.NSparkle = ns;
            if (ms.Int("pokeStarFame") is { } psf)
                p5x.PokeStarFame = (byte)psf;
        }
        SetRibbons(pk, ms);

        if (isEgg)
        {
            // PK3.IsEgg = true also writes the nickname タマゴ and sets language Japanese, as the
            // games do, but it writes the name *before* switching the language, so on a
            // non-Japanese entity the name is encoded with the wrong character table. Switch the
            // language first so the bytes are the real ones (60 6F 8B FF ...).
            if (gen == 3)
                pk.Language = (int)LanguageID.Japanese;
            pk.IsEgg = true;
            if (gen >= 4)
            {
                pk.Nickname = ms.Str("nickname") ?? SpeciesName.GetEggName(pk.Language, gen);
                pk.IsNicknamed = gen == 5; // Gen 4 eggs have the flag clear, Gen 5 eggs have it set
            }
        }
        else if (ms.Str("nickname") is { } nick)
        {
            pk.IsNicknamed = true;
            pk.Nickname = nick;
        }
        else
        {
            pk.IsNicknamed = false;
            pk.Nickname = SpeciesName.GetSpeciesNameGeneration(species, pk.Language, gen);
        }

        if (party)
            pk.ResetPartyStats();
        pk.RefreshChecksum();
        return pk;
    }
}

internal readonly record struct PidConstraints(
    byte Gen,
    ushort Species,
    byte Form,
    byte GenderRatio,
    int? Nature,
    int? Gender,
    int? AbilitySlot,
    bool Shiny,
    int? ShuffleOrder,
    ushort Tid,
    ushort Sid);

internal static class Pid
{
    public static int ShuffleOrder(byte gen, uint pid) => gen == 3 ? (int)(pid % 24) : (int)(((pid >> 13) & 31) % 24);

    public static bool IsShiny(uint pid, ushort tid, ushort sid) => (tid ^ sid ^ (pid >> 16) ^ (pid & 0xFFFF)) < 8;

    public static bool Matches(in PidConstraints c, uint pid)
    {
        if (c.Nature is { } n && pid % 25 != n)
            return false;
        if (c.Gender is { } g && c.GenderRatio is not (PersonalInfo.RatioMagicGenderless or PersonalInfo.RatioMagicFemale or PersonalInfo.RatioMagicMale))
        {
            if (EntityGender.GetFromPIDAndRatio(pid, c.GenderRatio) != g)
                return false;
        }
        if (c.AbilitySlot is { } a)
        {
            uint bit = c.Gen == 5 ? (pid >> 16) & 1 : pid & 1;
            if (bit != a)
                return false;
        }
        if (IsShiny(pid, c.Tid, c.Sid) != c.Shiny)
            return false;
        if (c.Gen == 3 && c.Species == (int)PKHeX.Core.Species.Unown && EntityPID.GetUnownForm3(pid) != c.Form)
            return false;
        if (c.ShuffleOrder is { } so && ShuffleOrder(c.Gen, pid) != so)
            return false;
        return true;
    }

    /// <summary>
    /// Seeded search over the GBA/NDS LCRNG sequence. Shiny requests build the high half from the
    /// trainer IDs so every candidate is shiny.
    /// </summary>
    public static uint Find(in PidConstraints c, uint seed)
    {
        uint state = seed;
        for (long i = 0; i < 400_000_000; i++)
        {
            state = (state * 0x41C64E6D) + 0x6073;
            uint a = state >> 16;
            state = (state * 0x41C64E6D) + 0x6073;
            uint b = state >> 16;
            uint pid = c.Shiny
                ? ((((uint)c.Tid ^ c.Sid ^ a ^ (b & 7)) & 0xFFFFu) << 16) | a
                : (b << 16) | a;
            if (Matches(c, pid))
                return pid;
        }
        throw new OracleException($"no PID found for {c}");
    }
}
