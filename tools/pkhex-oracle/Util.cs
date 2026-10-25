using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json.Nodes;
using PKHeX.Core;

namespace PkhexOracle;

/// <summary>Entity and list sizes (PKHeX keeps its own constants internal).</summary>
internal static class Sizes
{
    public const int _1ULIST = 69;   // PKHeX single-entry list: count, species, 0xFF, party struct, OT(11), nickname(11)
    public const int _1JLIST = 59;   // same with 6-byte Japanese strings
    public const int _1PARTY = 44;
    public const int _1STORED = 33;
    public const int _2ULIST = 73;
    public const int _2JLIST = 63;
    public const int _2PARTY = 48;
    public const int _2STORED = 32;
    public const int _3PARTY = 100;
    public const int _3STORED = 80;
    public const int _4PARTY = 236;
    public const int _4STORED = 136;
    public const int _5PARTY = 220;
    public const int _5STORED = 136;
}

internal sealed class OracleException(string message) : Exception(message);

/// <summary>A clock frozen at one instant so PKHeX code paths that read "today" are reproducible.</summary>
internal sealed class FixedTimeProvider(DateTimeOffset now) : TimeProvider
{
    public override DateTimeOffset GetUtcNow() => now;
    public override TimeZoneInfo LocalTimeZone => TimeZoneInfo.Utc;
}

internal static class Util
{
    /// <summary>Default "today" for PKHeX code that stamps dates (Pal Park transfer, traded eggs).</summary>
    public const string DefaultNow = "2010-01-01";

    public static string PkhexVersion
    {
        get
        {
            var v = typeof(SaveFile).Assembly.GetName().Version;
            return v is null ? "unknown" : $"{v.Major}.{v.Minor}.{v.Build}";
        }
    }

    public static void Init()
    {
        CultureInfo.DefaultThreadCurrentCulture = CultureInfo.InvariantCulture;
        CultureInfo.CurrentCulture = CultureInfo.InvariantCulture;

        var nowText = Environment.GetEnvironmentVariable("PKHEX_ORACLE_NOW");
        if (string.IsNullOrWhiteSpace(nowText))
            nowText = DefaultNow;
        var now = DateTimeOffset.Parse(nowText + (nowText.Length == 10 ? "T12:00:00Z" : ""), CultureInfo.InvariantCulture);
        EncounterDate.TimeProvider = new FixedTimeProvider(now);

        // Never let PKHeX silently "convert" between formats that have no real transfer route.
        EntityConverter.AllowIncompatibleConversion = EntityCompatibilitySetting.DisallowIncompatible;
        // Saves are always told explicitly whether to adapt an entity or touch the Pokédex.
        SaveFile.SetUpdateDex = PKMImportSetting.Skip;
        SaveFile.SetUpdatePKM = PKMImportSetting.Skip;
        SaveFile.SetUpdateRecords = PKMImportSetting.Skip;
    }

    // ---------------------------------------------------------------- languages / games

    public static LanguageID ParseLang(string s) => s.Trim().ToLowerInvariant() switch
    {
        "ja" or "jp" or "jpn" or "japanese" => LanguageID.Japanese,
        "en" or "eng" or "english" or "int" => LanguageID.English,
        "fr" or "fre" or "french" => LanguageID.French,
        "it" or "ita" or "italian" => LanguageID.Italian,
        "de" or "ger" or "german" => LanguageID.German,
        "es" or "spa" or "spanish" => LanguageID.Spanish,
        "ko" or "kor" or "korean" => LanguageID.Korean,
        _ => Enum.TryParse<LanguageID>(s, true, out var l) ? l : throw new OracleException($"unknown language '{s}'"),
    };

    public static string? LangCode(int id) => id switch
    {
        1 => "ja",
        2 => "en",
        3 => "fr",
        4 => "it",
        5 => "de",
        7 => "es",
        8 => "ko",
        _ => null,
    };

    public static GameVersion ParseGame(string s)
    {
        if (Enum.TryParse<GameVersion>(s.Trim(), true, out var g) && Enum.IsDefined(g))
            return g;
        throw new OracleException($"unknown GameVersion '{s}' (use PKHeX names: RD GN BU YW GD SI C R S E FR LG D P Pt HG SS B W B2 W2)");
    }

    public static string FormatName(byte gen) => $"pk{gen}";

    public static byte ParseFormat(string s)
    {
        var t = s.Trim().ToLowerInvariant();
        if (t.Length == 3 && t.StartsWith("pk") && t[2] is >= '1' and <= '5')
            return (byte)(t[2] - '0');
        throw new OracleException($"unknown format '{s}' (expected pk1..pk5)");
    }

    // ---------------------------------------------------------------- hex

    public static string Hex(ReadOnlySpan<byte> data) => Convert.ToHexString(data).ToLowerInvariant();

    public static byte[] ParseHex(string hex)
    {
        var clean = new string(hex.Where(c => !char.IsWhiteSpace(c) && c != ':' && c != '-').ToArray());
        if (clean.StartsWith("0x", StringComparison.OrdinalIgnoreCase))
            clean = clean[2..];
        if (clean.Length % 2 != 0)
            throw new OracleException("hex string has an odd number of digits");
        try
        {
            return Convert.FromHexString(clean);
        }
        catch (FormatException)
        {
            throw new OracleException("invalid hex string");
        }
    }

    public static string Sha256(ReadOnlySpan<byte> data) => Hex(SHA256.HashData(data));

    // ---------------------------------------------------------------- JSON spec accessors

    public static JsonNode ReadJsonFile(string path)
    {
        try
        {
            return JsonNode.Parse(File.ReadAllText(path), documentOptions: new System.Text.Json.JsonDocumentOptions
            {
                CommentHandling = System.Text.Json.JsonCommentHandling.Skip,
                AllowTrailingCommas = true,
            }) ?? throw new OracleException($"{path}: empty JSON");
        }
        catch (System.Text.Json.JsonException e)
        {
            throw new OracleException($"{path}: {e.Message}");
        }
    }

    public static bool Has(this JsonObject o, string key) => o.TryGetPropertyValue(key, out var v) && v is not null;

    public static int? Int(this JsonObject o, string key)
    {
        if (!o.TryGetPropertyValue(key, out var v) || v is null)
            return null;
        if (v is JsonValue jv)
        {
            if (jv.TryGetValue<int>(out var i))
                return i;
            if (jv.TryGetValue<long>(out var l))
                return checked((int)l);
            if (jv.TryGetValue<double>(out var d) && Math.Abs(d - Math.Round(d)) < 1e-9)
                return (int)d;
            if (jv.TryGetValue<string>(out var s))
            {
                s = s.Trim();
                if (s.StartsWith("0x", StringComparison.OrdinalIgnoreCase))
                    return Convert.ToInt32(s[2..], 16);
                if (int.TryParse(s, NumberStyles.Integer, CultureInfo.InvariantCulture, out var p))
                    return p;
            }
        }
        throw new OracleException($"'{key}' must be an integer");
    }

    public static uint? UInt(this JsonObject o, string key)
    {
        if (!o.TryGetPropertyValue(key, out var v) || v is null)
            return null;
        if (v is JsonValue jv)
        {
            if (jv.TryGetValue<long>(out var l))
                return checked((uint)l);
            if (jv.TryGetValue<string>(out var s))
            {
                s = s.Trim();
                if (s.StartsWith("0x", StringComparison.OrdinalIgnoreCase))
                    return Convert.ToUInt32(s[2..], 16);
                return uint.Parse(s, CultureInfo.InvariantCulture);
            }
        }
        throw new OracleException($"'{key}' must be an unsigned integer");
    }

    public static string? Str(this JsonObject o, string key)
    {
        if (!o.TryGetPropertyValue(key, out var v) || v is null)
            return null;
        if (v is JsonValue jv && jv.TryGetValue<string>(out var s))
            return s;
        throw new OracleException($"'{key}' must be a string");
    }

    public static bool? Bool(this JsonObject o, string key)
    {
        if (!o.TryGetPropertyValue(key, out var v) || v is null)
            return null;
        if (v is JsonValue jv && jv.TryGetValue<bool>(out var b))
            return b;
        throw new OracleException($"'{key}' must be true or false");
    }

    public static JsonObject? Obj(this JsonObject o, string key)
    {
        if (!o.TryGetPropertyValue(key, out var v) || v is null)
            return null;
        return v as JsonObject ?? throw new OracleException($"'{key}' must be an object");
    }

    public static JsonArray? Arr(this JsonObject o, string key)
    {
        if (!o.TryGetPropertyValue(key, out var v) || v is null)
            return null;
        return v as JsonArray ?? throw new OracleException($"'{key}' must be an array");
    }

    public static int[] Ints(this JsonArray a) => a.Select((n, i) =>
    {
        if (n is JsonValue jv && jv.TryGetValue<int>(out var x))
            return x;
        throw new OracleException($"array element {i} must be an integer");
    }).ToArray();

    public static JsonArray ToJsonArray(this IEnumerable<int> values) => new(values.Select(v => (JsonNode)JsonValue.Create(v)).ToArray());

    public static JsonArray ToJsonArray(this IEnumerable<string> values) => new(values.Select(v => (JsonNode)JsonValue.Create(v)).ToArray());

    public static DateOnly ParseDate(string s) => DateOnly.ParseExact(s, "yyyy-MM-dd", CultureInfo.InvariantCulture);

    /// <summary>Deterministic 32-bit FNV-1a hash, used to seed PID searches.</summary>
    public static uint Fnv(string s)
    {
        uint h = 2166136261;
        foreach (var c in s)
        {
            h ^= c;
            h *= 16777619;
        }
        return h;
    }
}
