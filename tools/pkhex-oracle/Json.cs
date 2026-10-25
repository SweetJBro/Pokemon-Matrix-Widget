using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace PkhexOracle;

/// <summary>
/// Deterministic, compact-but-readable JSON writer. Objects whose values are all primitives are
/// written on one line when short; arrays of primitives are written inline and wrapped at ~100
/// columns. Key order is insertion order, so output is byte-stable for a given input.
/// </summary>
internal static class Json
{
    private const int Width = 100;

    private static readonly JsonSerializerOptions ValueOptions = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    public static string Write(JsonNode? node)
    {
        var sb = new StringBuilder();
        WriteNode(sb, node, 0);
        sb.Append('\n');
        return sb.ToString();
    }

    private static string Scalar(JsonNode? node) => node is null ? "null" : node.ToJsonString(ValueOptions);

    private static bool IsScalar(JsonNode? node) => node is null or JsonValue;

    private static void Indent(StringBuilder sb, int level) => sb.Append(' ', level * 2);

    private static string? TryInline(JsonNode? node)
    {
        switch (node)
        {
            case null:
            case JsonValue:
                return Scalar(node);
            case JsonObject o:
            {
                if (o.Count == 0)
                    return "{}";
                if (!o.All(kv => IsScalar(kv.Value)))
                    return null;
                var parts = o.Select(kv => $"{JsonSerializer.Serialize(kv.Key, ValueOptions)}: {Scalar(kv.Value)}");
                return "{" + string.Join(", ", parts) + "}";
            }
            case JsonArray a:
            {
                if (a.Count == 0)
                    return "[]";
                if (!a.All(IsScalar))
                    return null;
                return "[" + string.Join(", ", a.Select(Scalar)) + "]";
            }
        }
        return null;
    }

    private static void WriteNode(StringBuilder sb, JsonNode? node, int level)
    {
        var inline = TryInline(node);
        if (inline is not null && inline.Length + (level * 2) <= Width)
        {
            sb.Append(inline);
            return;
        }

        switch (node)
        {
            case JsonObject o:
            {
                sb.Append("{\n");
                int i = 0;
                foreach (var kv in o)
                {
                    Indent(sb, level + 1);
                    sb.Append(JsonSerializer.Serialize(kv.Key, ValueOptions)).Append(": ");
                    WriteNode(sb, kv.Value, level + 1);
                    if (++i < o.Count)
                        sb.Append(',');
                    sb.Append('\n');
                }
                Indent(sb, level);
                sb.Append('}');
                return;
            }
            case JsonArray a when a.All(IsScalar):
            {
                // Wrapped list of scalars.
                sb.Append("[\n");
                Indent(sb, level + 1);
                int col = (level + 1) * 2;
                for (int i = 0; i < a.Count; i++)
                {
                    var s = Scalar(a[i]) + (i + 1 < a.Count ? "," : "");
                    if (col + s.Length + 1 > Width && col > (level + 1) * 2)
                    {
                        sb.Append('\n');
                        Indent(sb, level + 1);
                        col = (level + 1) * 2;
                    }
                    else if (i > 0)
                    {
                        sb.Append(' ');
                        col++;
                    }
                    sb.Append(s);
                    col += s.Length;
                }
                sb.Append('\n');
                Indent(sb, level);
                sb.Append(']');
                return;
            }
            case JsonArray a:
            {
                sb.Append("[\n");
                for (int i = 0; i < a.Count; i++)
                {
                    Indent(sb, level + 1);
                    WriteNode(sb, a[i], level + 1);
                    if (i + 1 < a.Count)
                        sb.Append(',');
                    sb.Append('\n');
                }
                Indent(sb, level);
                sb.Append(']');
                return;
            }
            default:
                // A long string scalar.
                sb.Append(Scalar(node));
                return;
        }
    }
}
