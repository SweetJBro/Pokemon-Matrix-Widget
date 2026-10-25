using System.Buffers.Binary;
using System.Text.Json.Nodes;
using PKHeX.Core;

namespace PkhexOracle;

/// <summary>
/// Creates the starting save for a game/language.
///
/// PKHeX's <c>SaveUtil.GetBlankSAV</c> objects are editor templates, not game-loadable images:
/// Gen 3/4 blanks have no backing flash image at all (Write() throws), Gen 1/2 blanks write list
/// headers that PKHeX's own detector rejects, and the Gen 5 blank has raw-zero box slots (Bad
/// Eggs in game) and an empty save footer. So this class supplies the minimum container skeleton
/// a freshly saved game has, and lets PKHeX do everything else (all trainer/entity/checksum
/// writes go through PKHeX):
///
///  Gen 1/2  PKHeX blank object plus empty list headers (count 0, 0xFF terminator) for the party,
///           the current-box copy and every box, as a new game writes them, and (international
///           Gen 2 only) the 0x63/0x7F "save exists" check bytes. Gen 2 images are cut
///           to the 32 KiB cartridge size except Japanese Crystal (64 KiB); PKHeX's blank SAV2 is
///           always 64 KiB and never uses the upper half for those layouts.
///  Gen 3    128 KiB flash written as a game that saved twice: slot B (save counter 1, sector
///           rotation 1) holds the blank game with the trainer set, slot A (counter 2, rotation 2)
///           is the active copy that the build edits. Extra sectors (Hall of Fame etc.) erased (0xFF).
///  Gen 4    512 KiB flash, also "saved twice": partition B (counters 1) holds the blank game,
///           partition A (counters 2) the active copy. Extra blocks erased (0xFF).
///  Gen 5    PKHeX's blank image, every slot rewritten with PKHeX's encrypted empty entity, save
///           footer given its count/size/magic, and the main copy mirrored to the backup copy as
///           an older save (backup count 1, main count 2). PKHeX only ever edits the main copy.
/// </summary>
internal static class Skeleton
{
    public const uint Gen3Signature = 0x08012025;
    public const uint Gen3DefaultSecurityKey = 0x6D2B79F5; // Emerald/FRLG key used when the spec gives none
    public const uint Gen5FooterMagic = 0x31053527;

    /// <param name="init">Applied to the fresh save before it is snapshotted as the "older" copy
    /// (trainer fields etc.), so both copies agree on everything except Pokémon.</param>
    public static (SaveFile Sav, List<string> Notes) Create(GameVersion game, LanguageID lang, string trainerName, JsonObject? options, Action<SaveFile>? init = null)
    {
        var notes = new List<string>();
        var probe = SaveUtil.GetBlankSAV(game, trainerName, lang);
        switch (probe.Generation)
        {
            case 1:
            case 2:
                SeedGBLists(probe);
                notes.Add(probe is SAV2 { Japanese: false, Korean: false }
                    ? "Gen 2: empty list headers (count 0, 0xFF) seeded for party, current box and every box; check bytes 0x63/0x7F seeded in primary and backup"
                    : $"Gen {probe.Generation}: empty list headers (count 0, 0xFF) seeded for party, current box and every box");
                if (probe is SAV1 { Version: GameVersion.YW } y)
                {
                    y.PikaFriendship = 90; // Yellow's new-game value; PKHeX uses it to tell Yellow from R/B
                    notes.Add("Gen 1 Yellow: Pikachu friendship byte set (PKHeX tells Yellow from R/B by starter / this byte)");
                }
                SetDefaultBoxNames(probe, lang);
                init?.Invoke(probe);
                return (probe, notes);
            case 3:
                return (CreateGen3(game, lang, trainerName, options, init, notes), notes);
            case 4:
                return (CreateGen4(game, lang, trainerName, init, notes), notes);
            default:
                return (CreateGen5(probe, lang, init, notes), notes);
        }
    }

    /// <summary>Final container adjustments after PKHeX serialises the save.</summary>
    public static byte[] Finish(SaveFile sav, byte[] written, List<string> notes)
    {
        if (sav is SAV2 s2 && written.Length == SaveUtil.SIZE_G2RAW_J && !(s2.Japanese && s2.Version == GameVersion.C))
        {
            if (written.AsSpan(SaveUtil.SIZE_G2RAW_U).ContainsAnyExcept<byte>(0))
                throw new OracleException("PKHeX wrote data above 32 KiB in a 32 KiB Gen 2 layout; refusing to truncate");
            notes.Add("Gen 2: truncated PKHeX's 64 KiB image to the 32 KiB cartridge SRAM size");
            return written[..SaveUtil.SIZE_G2RAW_U];
        }
        return written;
    }

    /// <summary>
    /// Writes PKHeX's blank entity into every box slot. (SaveFile.ClearBoxes skips slots whose bytes
    /// are all zero, so it cannot be used to turn raw zeros into Gen 4/5 encrypted empties.)
    /// </summary>
    private static void WriteEmptySlots(SaveFile sav)
    {
        for (int b = 0; b < sav.BoxCount; b++)
        {
            for (int s = 0; s < sav.BoxSlotCount; s++)
                sav.SetBoxSlotAtIndex(sav.BlankPKM, b, s, PKMImportSetting.Skip, PKMImportSetting.Skip);
        }
        if (sav.Generation >= 3)
        {
            for (int i = sav.PartyCount; i < 6; i++)
                sav.SetPartySlotAtIndex(sav.BlankPKM, i, PKMImportSetting.Skip, PKMImportSetting.Skip);
        }
    }

    /// <summary>Oracle-chosen default box names (PKHeX blanks leave them empty or unterminated).</summary>
    private static void SetDefaultBoxNames(SaveFile sav, LanguageID lang)
    {
        if (sav is not IBoxDetailName names)
            return;
        for (int i = 0; i < sav.BoxCount; i++)
        {
            var n = (lang, sav.Generation) switch
            {
                (LanguageID.Japanese, _) => "ボックス" + string.Concat((i + 1).ToString().Select(c => (char)('０' + (c - '0')))),
                (_, 2) => $"BOX{i + 1}",
                (_, 5) => $"Box {i + 1}",
                _ => $"BOX {i + 1}",
            };
            names.SetBoxName(i, n);
        }
    }

    // ------------------------------------------------------------------ Gen 1/2

    private static void SeedGBLists(SaveFile sav)
    {
        var data = sav.Data;
        void Empty(int ofs)
        {
            data[ofs] = 0;
            data[ofs + 1] = 0xFF;
        }
        // A new game writes empty party and current-box lists. Gen 2 also erases every box at new
        // game; Gen 1 erases the box banks on the first box change (which sets bit 7 of the current
        // box byte). Seeding all of them lets PKHeX's list writer emit proper empty lists
        // (it skips a list whose destination bytes are all zero).
        Empty(Raw.PartyListOffset(sav));
        Empty(Raw.CurrentBoxCopyOffset(sav));
        for (int b = 0; b < sav.BoxCount; b++)
            Empty(Raw.BankBoxListOffset(sav, b));

        // Gen 2 "save exists" check bytes (0x63 before the game data, 0x7F after it, in the primary
        // and the backup copy). PKHeX neither writes nor checks them, but the games refuse to
        // CONTINUE without them. Offsets are only verified for the international layouts
        // (docs/research/format-gen1-gen2.md 5.1-5.3); Japanese and Korean saves are left alone.
        if (sav is SAV2 { Japanese: false, Korean: false } s2)
        {
            data[0x2008] = 0x63;
            if (s2.Version == GameVersion.C)
            {
                data[0x2D0F] = 0x7F;
                data[0x1208] = 0x63;
                data[0x1F0F] = 0x7F;
            }
            else
            {
                data[0x2D6B] = 0x7F;
                data[0x7E38] = 0x63;
                data[0x7E6F] = 0x7F;
            }
        }
    }

    // ------------------------------------------------------------------ Gen 3

    private const int Sector = 0x1000;
    private const int SectorsPerSlot = 14;

    private static SaveFile CreateGen3(GameVersion game, LanguageID lang, string trainerName, JsonObject? options, Action<SaveFile>? init, List<string> notes)
    {
        bool jp = lang == LanguageID.Japanese;
        var img = new byte[SaveUtil.SIZE_G3RAW];
        img.AsSpan().Fill(0xFF);

        var g3 = options?.Obj("gen3");
        uint key = g3?.UInt("securityKey") ?? Gen3DefaultSecurityKey;
        uint smallAC = game switch
        {
            GameVersion.R or GameVersion.S or GameVersion.RS => 0,
            GameVersion.FR or GameVersion.LG or GameVersion.FRLG => 1,
            _ => key,
        };

        void Slot(int slot, int rotation, uint counter)
        {
            for (int k = 0; k < SectorsPerSlot; k++)
            {
                int ofs = (slot * SectorsPerSlot * Sector) + (k * Sector);
                var s = img.AsSpan(ofs, Sector);
                s.Clear();
                ushort id = (ushort)((k + rotation) % SectorsPerSlot);
                BinaryPrimitives.WriteUInt16LittleEndian(s[0xFF4..], id);
                BinaryPrimitives.WriteUInt32LittleEndian(s[0xFF8..], Gen3Signature);
                BinaryPrimitives.WriteUInt32LittleEndian(s[0xFFC..], counter);
                if (id == 0)
                {
                    // Trainer name buffer: 0xFF filled. PKHeX decides JP vs INT from bytes 6-7
                    // (the game leaves them 0 in Japanese saves, 0xFF-filled otherwise).
                    s[..(jp ? 6 : 8)].Fill(0xFF);
                    BinaryPrimitives.WriteUInt32LittleEndian(s[0xAC..], smallAC);
                }
            }
        }
        Slot(1, 1, 1); // older copy
        Slot(0, 2, 2); // active copy

        SAV3 sav = game switch
        {
            GameVersion.R or GameVersion.S or GameVersion.RS => new SAV3RS(img),
            GameVersion.FR or GameVersion.LG or GameVersion.FRLG => new SAV3FRLG(img),
            _ => new SAV3E(img),
        };
        if (sav.Japanese != jp)
            throw new OracleException("Gen 3 skeleton: PKHeX misread the Japanese flag");
        sav.Version = game;
        sav.OT = trainerName;
        sav.SetDisplayID(12345, 54321);
        sav.Language = (int)lang;
        if (sav is SAV3E e)
        {
            // PKHeX tells Emerald from Ruby/Sapphire by a non-zero security key AND any non-zero
            // byte in small-block 0x890-0xF2C. A pristine Emerald has nothing there, so give it
            // Battle Points; otherwise PKHeX reloads the file as Ruby/Sapphire.
            e.BP = g3?.UInt("battlePoints") ?? 1;
            notes.Add($"Gen 3 Emerald: security key 0x{key:X8}, Battle Points {e.BP} (PKHeX needs a non-zero byte in small-block 0x890-0xF2C to detect Emerald)");
        }
        else if (sav is SAV3FRLG f)
        {
            f.SecurityKey = key;
            notes.Add($"Gen 3 FRLG: security key 0x{key:X8}, small-block 0xAC = 1");
        }
        WriteEmptySlots(sav);
        SetDefaultBoxNames(sav, lang);
        init?.Invoke(sav);
        sav.WriteBothSaveSlots(sav.Data);
        notes.Add("Gen 3: slot B = blank game (sector counter 1, rotation 1), slot A = active copy (counter 2, rotation 2)");
        return sav;
    }

    // ------------------------------------------------------------------ Gen 4

    private const int Partition = 0x40000;

    private static (int GSize, int SStart, int SSize, int Footer) Layout4(GameVersion game) => game switch
    {
        GameVersion.D or GameVersion.P or GameVersion.DP => (0xC100, 0xC100, 0x121E0, 0x14),
        GameVersion.Pt => (0xCF2C, 0xCF2C, 0x121E4, 0x14),
        GameVersion.HG or GameVersion.SS or GameVersion.HGSS => (0xF628, 0xF700, 0x12310, 0x10),
        _ => throw new OracleException($"not a Gen 4 game: {game}"),
    };

    private static SAV4 Load4(GameVersion game, byte[] img) => game switch
    {
        GameVersion.D or GameVersion.P or GameVersion.DP => new SAV4DP(img),
        GameVersion.Pt => new SAV4Pt(img),
        _ => new SAV4HGSS(img),
    };

    private static void Footer4(Span<byte> block, int footer, uint counter, uint magic, byte id)
    {
        var f = block[^footer..];
        if (footer == 0x14)
        {
            BinaryPrimitives.WriteUInt32LittleEndian(f, counter);          // saveCounter
            BinaryPrimitives.WriteUInt32LittleEndian(f[0x04..], counter);  // blockCounter
            BinaryPrimitives.WriteUInt32LittleEndian(f[0x08..], (uint)block.Length);
            BinaryPrimitives.WriteUInt32LittleEndian(f[0x0C..], magic);
            f[0x10] = id;
            f[0x11] = 0;
        }
        else
        {
            BinaryPrimitives.WriteUInt32LittleEndian(f, counter);          // count
            BinaryPrimitives.WriteUInt32LittleEndian(f[0x04..], (uint)block.Length);
            BinaryPrimitives.WriteUInt32LittleEndian(f[0x08..], magic);
            BinaryPrimitives.WriteUInt16LittleEndian(f[0x0C..], id);
        }
    }

    private static SaveFile CreateGen4(GameVersion game, LanguageID lang, string trainerName, Action<SaveFile>? init, List<string> notes)
    {
        var (gSize, sStart, sSize, footer) = Layout4(game);
        uint magic = lang == LanguageID.Korean ? SAV4.MAGIC_KOREAN : SAV4.MAGIC_JAPAN_INTL;

        // Stage 1: first save, written to partition B (as the games do); partition A erased.
        var img = new byte[SaveUtil.SIZE_G4RAW];
        img.AsSpan().Fill(0xFF);
        var gB = img.AsSpan(Partition, gSize);
        var sB = img.AsSpan(Partition + sStart, sSize);
        gB.Clear();
        sB.Clear();
        Footer4(gB, footer, 1, magic, 0);
        Footer4(sB, footer, 1, magic, 1);

        var first = Load4(game, img);
        first.Version = game;
        first.OT = trainerName;
        first.SetDisplayID(12345, 54321);
        first.Language = (int)lang;
        WriteEmptySlots(first);
        SetDefaultBoxNames(first, lang);
        first.Dex.Magic = 0xBEEFCAFE;
        first.Dex.ClearUnownForms();
        init?.Invoke(first);
        var stage1 = first.Write();

        // Stage 2: second save to partition A (counters 2) with the same contents.
        var img2 = stage1.ToArray();
        stage1.AsSpan(Partition, gSize).CopyTo(img2.AsSpan(0, gSize));
        stage1.AsSpan(Partition + sStart, sSize).CopyTo(img2.AsSpan(sStart, sSize));
        Footer4(img2.AsSpan(0, gSize), footer, 2, magic, 0);
        Footer4(img2.AsSpan(sStart, sSize), footer, 2, magic, 1);
        var sav = Load4(game, img2);
        if (sav.OT != first.OT)
            throw new OracleException("Gen 4 skeleton: PKHeX did not select partition A");
        notes.Add($"Gen 4: partition B = blank game (counters 1), partition A = active copy (counters 2); block magic 0x{magic:X8}; Pokédex magic 0xBEEFCAFE and Unown list cleared; empty slots are PKHeX's encrypted blank entity");
        return sav;
    }

    // ------------------------------------------------------------------ Gen 5

    private static SaveFile CreateGen5(SaveFile blank, LanguageID lang, Action<SaveFile>? init, List<string> notes)
    {
        bool b2w2 = blank is SAV5B2W2;
        int copy = b2w2 ? 0x26000 : 0x24000;
        int footer = b2w2 ? 0x25F94 : 0x23F8C;
        uint size = b2w2 ? 0x25FA4u : 0x23F9Cu;

        WriteEmptySlots(blank);
        SetDefaultBoxNames(blank, lang);
        init?.Invoke(blank);
        var img = blank.Write();

        void Footer(int at, uint count)
        {
            var f = img.AsSpan(at, 0x10);
            BinaryPrimitives.WriteUInt32LittleEndian(f, count);
            BinaryPrimitives.WriteUInt32LittleEndian(f[0x4..], size);
            BinaryPrimitives.WriteUInt32LittleEndian(f[0x8..], Gen5FooterMagic);
            // +0xE: CRC of the CRC table, already written by PKHeX (unaffected by these fields).
        }
        Footer(footer, 1);
        img.AsSpan(0, copy).CopyTo(img.AsSpan(copy, copy));
        Footer(footer, 2);

        SaveFile sav = b2w2 ? new SAV5B2W2(img) : new SAV5BW(img);
        notes.Add($"Gen 5: PKHeX blank image; slots rewritten as PKHeX's encrypted empty entity; footer count/size/magic (0x{Gen5FooterMagic:X8}) set; backup copy = blank game (count 1), main = active copy (count 2)");
        return sav;
    }
}
