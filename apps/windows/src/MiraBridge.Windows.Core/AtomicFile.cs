using System.Text;

namespace MiraBridge.Windows.Core;

public static class AtomicFile
{
    public static async Task WriteTextAsync(string path, string content, bool backup, CancellationToken cancellationToken = default)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path) ?? throw new InvalidDataException("Destination has no parent directory."));
        string temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        await using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough))
        await using (var writer = new StreamWriter(stream, new UTF8Encoding(false)))
        {
            await writer.WriteAsync(content.AsMemory(), cancellationToken);
            await writer.FlushAsync(cancellationToken);
            stream.Flush(flushToDisk: true);
        }
        if (File.Exists(path))
        {
            string? backupPath = backup ? path + ".mirabridge.bak" : null;
            File.Replace(temporary, path, backupPath, ignoreMetadataErrors: true);
        }
        else File.Move(temporary, path);
    }
}
