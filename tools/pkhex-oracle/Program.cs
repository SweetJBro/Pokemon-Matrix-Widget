using System.Text;
using System.Text.Json.Nodes;

namespace PkhexOracle;

/// <summary>
/// pkhex-oracle: a development-only command-line wrapper around PKHeX.Core used to
/// differential-test the widget's JavaScript save code. Not shipped with the widget.
/// Every command prints one JSON document on stdout. Errors print {"ok": false, "error": ...}
/// and exit with status 1.
/// </summary>
internal static class Program
{
    private const string Usage = """
        usage: pkhex-oracle <command> ...
          blank   <GameVersion> <lang> <out.sav>           blank save for a game/language
          build   <spec.json> <out.sav>                    save from a JSON spec (see README.md)
          dump    <in.sav>                                 PKHeX's view of a save
          pkm     <pk1..pk5> <hex> [--decrypted] [--egg]   parse one record
          convert <from> <to> <hex> [--decrypted] [--egg]  PKHeX EntityConverter (to = pk1..pk5, pk7)
          modify  <in.sav> <out.sav> <ops.json>            apply slot operations and save
          roundtrip <in.sav>                               load + re-save with PKHeX; report byte/dump changes
          blankpkm <pk1..pk5>                              PKHeX's empty-slot entity as a record
          version                                          PKHeX.Core version
        environment: PKHEX_ORACLE_NOW=YYYY-MM-DD fixes PKHeX's notion of "today" (default 2010-01-01)
        """;

    public static int Main(string[] args)
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        Util.Init();
        if (args.Length == 0 || args[0] is "-h" or "--help" or "help")
        {
            Console.Error.WriteLine(Usage);
            return args.Length == 0 ? 2 : 0;
        }

        try
        {
            JsonNode result = args[0] switch
            {
                "blank" => Commands.Blank(args[1..]),
                "build" => Commands.Build(args[1..]),
                "dump" => Commands.Dump(args[1..]),
                "pkm" => Commands.Pkm(args[1..]),
                "convert" => Commands.Convert(args[1..]),
                "modify" => Commands.Modify(args[1..]),
                "roundtrip" => Commands.RoundTrip(args[1..]),
                "blankpkm" => Commands.BlankPkm(args[1..]),
                "version" => new JsonObject { ["tool"] = "pkhex-oracle", ["pkhexCore"] = Util.PkhexVersion, ["now"] = PKHeX.Core.EncounterDate.GetDateNDS().ToString("yyyy-MM-dd") },
                _ => throw new OracleException($"unknown command '{args[0]}'\n{Usage}"),
            };
            Console.Out.Write(Json.Write(result));
            return 0;
        }
        catch (Exception e)
        {
            var err = new JsonObject
            {
                ["ok"] = false,
                ["error"] = e.Message,
                ["type"] = e is OracleException ? "usage" : e.GetType().Name,
            };
            if (e is not OracleException)
                err["stack"] = e.ToString();
            Console.Out.Write(Json.Write(err));
            return 1;
        }
    }
}
