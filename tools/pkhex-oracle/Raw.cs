using System.Reflection;
using PKHeX.Core;

namespace PkhexOracle;

/// <summary>
/// Bytes exactly as they sit in the save image for one slot.
/// Gen 1/2: <see cref="Body"/> is the struct from the packed list (box struct in boxes, party
/// struct in the party), plus the OT name and nickname entries from the same list and the list's
/// species header byte (0xFD marks a Gen 2 egg).
/// Gen 3-5: <see cref="Body"/> is the encrypted slot (box size in boxes, party size in the party).
/// </summary>
internal sealed record RawSlot(byte[] Body, byte[]? OtName = null, byte[]? Nickname = null, int? ListSpecies = null, int? ListIndex = null);

/// <summary>
/// Reads raw slot bytes from a PKHeX save object. PKHeX only exposes decoded entities publicly, so
/// this uses reflection on PKHeX internals (offset tables, the protected box/party buffers). It is
/// version-specific to PKHeX.Core 24.7.27; a failure here throws loudly rather than guessing.
/// </summary>
internal static class Raw
{
    private const BindingFlags Any = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance;

    private delegate Span<byte> SpanGetter(SaveFile sav);

    private static readonly SpanGetter BoxBuffer = MakeGetter("BoxBuffer");
    private static readonly SpanGetter PartyBuffer = MakeGetter("PartyBuffer");

    private static SpanGetter MakeGetter(string name)
    {
        var prop = typeof(SaveFile).GetProperty(name, Any) ?? throw new OracleException($"PKHeX internals changed: SaveFile.{name} not found");
        var getter = prop.GetGetMethod(true) ?? throw new OracleException($"PKHeX internals changed: SaveFile.{name} has no getter");
        // Open-instance delegate over a virtual getter: dispatches to the runtime type's override.
        return (SpanGetter)Delegate.CreateDelegate(typeof(SpanGetter), getter);
    }

    // ------------------------------------------------------------------ Gen 1/2 packed lists

    private static object Offsets(SaveFile sav) =>
        sav.GetType().GetField("Offsets", Any)?.GetValue(sav) ?? throw new OracleException("PKHeX internals changed: Offsets field not found");

    public static int OffsetValue(SaveFile sav, string name)
    {
        var o = Offsets(sav);
        var t = o.GetType();
        if (t.GetProperty(name, Any) is { } p)
            return (int)p.GetValue(o)!;
        if (t.GetField(name, Any) is { } f)
            return (int)f.GetValue(o)!;
        throw new OracleException($"PKHeX internals changed: offset '{name}' not found on {t.Name}");
    }

    public static bool IsJapaneseGB(SaveFile sav) => sav is ILangDeviantSave l && l.Japanese;

    private static int NameLength(SaveFile sav) => IsJapaneseGB(sav) ? 6 : 11;

    /// <summary>Offset of a box's packed list in the box banks (bank 2/3 for Gen 1, the box banks for Gen 2).</summary>
    public static int BankBoxListOffset(SaveFile sav, int box)
    {
        switch (sav)
        {
            case SAV1:
            {
                var m = typeof(SAV1).GetMethod("GetBoxRawDataOffset", Any, [typeof(int)]) ?? throw new OracleException("PKHeX internals changed: SAV1.GetBoxRawDataOffset");
                return (int)m.Invoke(sav, [box])!;
            }
            case SAV2 s2:
            {
                var m = typeof(SAV2).GetMethod("GetBoxRawDataOffset", Any, [typeof(int), typeof(int)]) ?? throw new OracleException("PKHeX internals changed: SAV2.GetBoxRawDataOffset");
                int split = s2.Japanese ? 6 : 7;
                return (int)m.Invoke(sav, [box, split])!;
            }
            default:
                throw new OracleException("not a Gen 1/2 save");
        }
    }

    /// <summary>
    /// Offset of the packed list for a box, as PKHeX reads it: Gen 1 reads the current box from
    /// the bank-1 "current box" copy and the others from banks 2/3; Gen 2 reads every box
    /// (including the current one) from the box banks and ignores its current-box copy.
    /// </summary>
    public static int BoxListOffset(SaveFile sav, int box)
    {
        if (sav is SAV1 s1 && box == s1.CurrentBox)
            return OffsetValue(sav, "CurrentBox");
        return BankBoxListOffset(sav, box);
    }

    public static int PartyListOffset(SaveFile sav) => OffsetValue(sav, "Party");

    public static int CurrentBoxCopyOffset(SaveFile sav) => OffsetValue(sav, "CurrentBox");

    public static int BoxListLength(SaveFile sav) => ListLength(sav, sav.BoxSlotCount, false);

    private static int StructSize(SaveFile sav, bool party) => (sav.Generation, party) switch
    {
        (1, false) => Sizes._1STORED,
        (1, true) => Sizes._1PARTY,
        (2, false) => Sizes._2STORED,
        _ => Sizes._2PARTY,
    };

    private static int ListLength(SaveFile sav, int capacity, bool party) =>
        1 + (capacity + 1) + (capacity * (StructSize(sav, party) + (2 * NameLength(sav))));

    private static RawSlot ReadList(SaveFile sav, int listOffset, int capacity, bool party, int index)
    {
        var data = sav.Data;
        int nl = NameLength(sav);
        int body = StructSize(sav, party);
        int start = listOffset + 1 + capacity + 1;
        int ofsBody = start + (index * body);
        int ofsOt = start + (capacity * body) + (index * nl);
        int ofsNick = ofsOt + (capacity * nl);
        return new RawSlot(
            data.AsSpan(ofsBody, body).ToArray(),
            data.AsSpan(ofsOt, nl).ToArray(),
            data.AsSpan(ofsNick, nl).ToArray(),
            data[listOffset + 1 + index],
            index);
    }

    public static (int Count, byte[] Header) ListHeader(SaveFile sav, int listOffset, int capacity) =>
        (sav.Data[listOffset], sav.Data.AsSpan(listOffset + 1, capacity + 1).ToArray());

    // ------------------------------------------------------------------ public entry points

    public static RawSlot GetBoxSlot(SaveFile sav, int box, int slot)
    {
        if (sav.Generation <= 2)
            return ReadList(sav, BoxListOffset(sav, box), sav.BoxSlotCount, false, slot);

        var size = sav.BlankPKM.SIZE_STORED;
        var ofs = sav.GetBoxSlotOffset(box, slot);
        return new RawSlot(BoxBuffer(sav).Slice(ofs, size).ToArray());
    }

    public static RawSlot GetPartySlot(SaveFile sav, int index)
    {
        if (sav.Generation <= 2)
            return ReadList(sav, PartyListOffset(sav), 6, true, index);

        var size = sav.BlankPKM.SIZE_PARTY;
        var ofs = sav.GetPartyOffset(index);
        return new RawSlot(PartyBuffer(sav).Slice(ofs, size).ToArray());
    }
}
