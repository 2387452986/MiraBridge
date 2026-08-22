using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Win32.SafeHandles;

namespace MiraBridge.ConPtyHost;

internal sealed record StartRequest(
    [property: JsonPropertyName("program")] string Program,
    [property: JsonPropertyName("args")] string[] Args,
    [property: JsonPropertyName("cwd")] string Cwd,
    [property: JsonPropertyName("env")] Dictionary<string, string> Env,
    [property: JsonPropertyName("cols")] int Cols,
    [property: JsonPropertyName("rows")] int Rows);

internal sealed record ControlRequest(
    [property: JsonPropertyName("type")] string Type,
    [property: JsonPropertyName("data_base64")] string? DataBase64,
    [property: JsonPropertyName("cols")] int? Cols,
    [property: JsonPropertyName("rows")] int? Rows);

internal static class Program
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = false
    };

    public static async Task<int> Main()
    {
        Console.InputEncoding = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false);
        Console.OutputEncoding = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false);
        if (!OperatingSystem.IsWindows())
        {
            await Console.Error.WriteLineAsync("MiraBridge ConPTY Host requires Windows.");
            return 64;
        }

        try
        {
            string? line = await Console.In.ReadLineAsync();
            if (line is null)
            {
                throw new InvalidDataException("ConPTY start request is missing.");
            }

            StartRequest start = JsonSerializer.Deserialize<StartRequest>(line, JsonOptions)
                ?? throw new InvalidDataException("ConPTY start request is invalid.");
            Validate(start);

            using var session = new PseudoConsoleSession(start);
            Task output = session.CopyOutputAsync(Console.OpenStandardOutput());
            _ = session.ProcessControlAsync(Console.In);
            int exitCode = await session.WaitForExitAsync();
            session.ClosePseudoConsole();
            await output;
            return exitCode;
        }
        catch (Exception error)
        {
            await Console.Error.WriteLineAsync($"MiraBridge ConPTY Host failed: {error.Message}");
            return 1;
        }
    }

    private static void Validate(StartRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.Program)) throw new InvalidDataException("program is required.");
        if (string.IsNullOrWhiteSpace(request.Cwd)) throw new InvalidDataException("cwd is required.");
        if (request.Args.Length > 256) throw new InvalidDataException("args exceeds 256 entries.");
        if (request.Cols is < 20 or > 500 || request.Rows is < 5 or > 200) throw new InvalidDataException("terminal size is outside supported bounds.");
        if (request.Env.Count > 512) throw new InvalidDataException("env exceeds 512 entries.");
        if (request.Program.Contains('\0') || request.Cwd.Contains('\0') || request.Args.Any(value => value.Contains('\0')))
            throw new InvalidDataException("program, cwd, and args cannot contain NUL.");
        if (request.Env.Any(entry => entry.Key.Length == 0 || entry.Key.Contains('=') || entry.Key.Contains('\0') || entry.Value.Contains('\0')))
            throw new InvalidDataException("environment contains an invalid key or value.");
    }
}

internal sealed class PseudoConsoleSession : IDisposable
{
    private const uint ExtendedStartupInfoPresent = 0x00080000;
    private const uint CreateUnicodeEnvironment = 0x00000400;
    private const int StartfUseStdHandles = 0x00000100;
    private const int ProcThreadAttributePseudoConsole = 0x00020016;
    private readonly object sync = new();
    private IntPtr pseudoConsole;
    private IntPtr processHandle;
    private IntPtr attributeList;
    private FileStream? input;
    private SafeFileHandle? output;
    private bool pseudoConsoleClosed;

    public PseudoConsoleSession(StartRequest request)
    {
        CreatePipe(out IntPtr inputRead, out IntPtr inputWrite, IntPtr.Zero, 0).ThrowIfFalse("CreatePipe(input)");
        CreatePipe(out IntPtr outputRead, out IntPtr outputWrite, IntPtr.Zero, 0).ThrowIfFalse("CreatePipe(output)");
        try
        {
            using var inputReadHandle = new SafeFileHandle(inputRead, ownsHandle: false);
            using var outputWriteHandle = new SafeFileHandle(outputWrite, ownsHandle: false);
            int hr = CreatePseudoConsole(new Coord((short)request.Cols, (short)request.Rows), inputReadHandle, outputWriteHandle, 0, out pseudoConsole);
            if (hr < 0) Marshal.ThrowExceptionForHR(hr);
            input = new FileStream(new SafeFileHandle(inputWrite, ownsHandle: true), FileAccess.Write, 1, isAsync: false);
            inputWrite = IntPtr.Zero;
            output = new SafeFileHandle(outputRead, ownsHandle: true);
            outputRead = IntPtr.Zero;
            StartProcess(request);
            CloseHandle(inputRead);
            inputRead = IntPtr.Zero;
            CloseHandle(outputWrite);
            outputWrite = IntPtr.Zero;
        }
        finally
        {
            CloseIfValid(inputRead);
            CloseIfValid(inputWrite);
            CloseIfValid(outputRead);
            CloseIfValid(outputWrite);
        }
    }

    public Task CopyOutputAsync(Stream destination)
    {
        SafeFileHandle source = output ?? throw new InvalidOperationException("ConPTY output is unavailable.");
        return Task.Factory.StartNew(() =>
        {
            byte[] buffer = new byte[4096];
            while (true)
            {
                bool success = ReadFile(source, buffer, buffer.Length, out int read, IntPtr.Zero);
                if (!success)
                {
                    int code = Marshal.GetLastWin32Error();
                    if (code is 109 or 232) break;
                    throw new Win32Exception(code, "ReadFile(ConPTY output) failed.");
                }
                if (read <= 0) break;
                destination.Write(buffer, 0, read);
                destination.Flush();
            }
        }, CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default);
    }

    public Task ProcessControlAsync(TextReader reader)
    {
        return Task.Factory.StartNew(() =>
        {
            while (true)
            {
                string? line;
                try { line = reader.ReadLine(); }
                catch (Exception error)
                {
                    Console.Error.WriteLine($"ConPTY control stream failed: {error.Message}");
                    return;
                }
                if (line is null) return;
                try
                {
                    ControlRequest request = JsonSerializer.Deserialize<ControlRequest>(line)
                        ?? throw new InvalidDataException("Control request is invalid.");
                    switch (request.Type)
                    {
                        case "input":
                            if (request.DataBase64 is null) throw new InvalidDataException("input requires data_base64.");
                            WriteInput(Convert.FromBase64String(request.DataBase64));
                            break;
                        case "resize":
                            if (request.Cols is null || request.Rows is null) throw new InvalidDataException("resize requires cols and rows.");
                            Resize(request.Cols.Value, request.Rows.Value);
                            break;
                        case "close":
                            SendConsoleEndOfFile();
                            break;
                        default:
                            throw new InvalidDataException($"Unknown ConPTY control type: {request.Type}");
                    }
                }
                catch (Exception error)
                {
                    Console.Error.WriteLine($"ConPTY control request rejected: {error.Message}");
                }
            }
        }, CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default);
    }

    public Task<int> WaitForExitAsync()
    {
        IntPtr handle = processHandle;
        return Task.Factory.StartNew(() =>
        {
            uint wait = WaitForSingleObject(handle, 0xFFFFFFFF);
            if (wait != 0) throw new Win32Exception(Marshal.GetLastWin32Error(), "WaitForSingleObject failed.");
            GetExitCodeProcess(handle, out uint code).ThrowIfFalse("GetExitCodeProcess");
            return unchecked((int)code);
        }, CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default);
    }

    public void ClosePseudoConsole()
    {
        lock (sync)
        {
            if (pseudoConsoleClosed) return;
            pseudoConsoleClosed = true;
            CloseInput();
            if (pseudoConsole != IntPtr.Zero)
            {
                ClosePseudoConsoleNative(pseudoConsole);
                pseudoConsole = IntPtr.Zero;
            }
        }
    }

    public void Dispose()
    {
        ClosePseudoConsole();
        input?.Dispose();
        output?.Dispose();
        if (processHandle != IntPtr.Zero) CloseHandle(processHandle);
        if (attributeList != IntPtr.Zero)
        {
            DeleteProcThreadAttributeList(attributeList);
            Marshal.FreeHGlobal(attributeList);
        }
    }

    private void WriteInput(byte[] data)
    {
        FileStream stream;
        lock (sync)
        {
            if (input is null) throw new IOException("ConPTY input is closed.");
            stream = input;
        }
        stream.Write(data, 0, data.Length);
        stream.Flush();
    }

    private void CloseInput()
    {
        lock (sync)
        {
            input?.Dispose();
            input = null;
        }
    }

    private void SendConsoleEndOfFile()
    {
        // A Windows console represents interactive EOF as Ctrl-Z followed by Enter.
        // Closing the ConPTY input handle immediately instead terminates common REPLs
        // with STATUS_CONTROL_C_EXIT, so leave the handle alive until the child exits.
        WriteInput([0x1A, 0x0D]);
    }

    private void Resize(int cols, int rows)
    {
        if (cols is < 20 or > 500 || rows is < 5 or > 200) throw new InvalidDataException("terminal size is outside supported bounds.");
        lock (sync)
        {
            if (pseudoConsoleClosed || pseudoConsole == IntPtr.Zero) throw new InvalidOperationException("ConPTY is closed.");
            int hr = ResizePseudoConsole(pseudoConsole, new Coord((short)cols, (short)rows));
            if (hr < 0) Marshal.ThrowExceptionForHR(hr);
        }
    }

    private void StartProcess(StartRequest request)
    {
        IntPtr size = IntPtr.Zero;
        _ = InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
        attributeList = Marshal.AllocHGlobal(size);
        InitializeProcThreadAttributeList(attributeList, 1, 0, ref size).ThrowIfFalse("InitializeProcThreadAttributeList");
        UpdateProcThreadAttribute(attributeList, 0, (IntPtr)ProcThreadAttributePseudoConsole, pseudoConsole, (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero)
            .ThrowIfFalse("UpdateProcThreadAttribute");

        var startup = new StartupInfoEx
        {
            StartupInfo = new StartupInfo
            {
                Cb = Marshal.SizeOf<StartupInfoEx>(),
                Flags = StartfUseStdHandles,
                StdInput = IntPtr.Zero,
                StdOutput = IntPtr.Zero,
                StdError = IntPtr.Zero,
            },
            AttributeList = attributeList
        };
        string command = string.Join(" ", new[] { QuoteWindowsArgument(request.Program) }.Concat(request.Args.Select(QuoteWindowsArgument)));
        var commandLine = new StringBuilder(command);
        IntPtr environment = BuildEnvironment(request.Env);
        try
        {
            bool created = CreateProcess(
                null,
                commandLine,
                IntPtr.Zero,
                IntPtr.Zero,
                false,
                ExtendedStartupInfoPresent | CreateUnicodeEnvironment,
                environment,
                request.Cwd,
                ref startup,
                out ProcessInformation process);
            created.ThrowIfFalse("CreateProcess");
            processHandle = process.Process;
            CloseHandle(process.Thread);
        }
        finally
        {
            Marshal.FreeHGlobal(environment);
        }
    }

    private static IntPtr BuildEnvironment(Dictionary<string, string> values)
    {
        string block = string.Join('\0', values.OrderBy(entry => entry.Key, StringComparer.OrdinalIgnoreCase).Select(entry => $"{entry.Key}={entry.Value}")) + "\0\0";
        return Marshal.StringToHGlobalUni(block);
    }

    private static string QuoteWindowsArgument(string value)
    {
        if (value.Length > 0 && !value.Any(character => char.IsWhiteSpace(character) || character == '"')) return value;
        var output = new StringBuilder("\"");
        int slashes = 0;
        foreach (char character in value)
        {
            if (character == '\\')
            {
                slashes++;
                continue;
            }
            if (character == '"')
            {
                output.Append('\\', slashes * 2 + 1).Append('"');
                slashes = 0;
                continue;
            }
            output.Append('\\', slashes).Append(character);
            slashes = 0;
        }
        return output.Append('\\', slashes * 2).Append('"').ToString();
    }

    private static void CloseIfValid(IntPtr handle)
    {
        if (handle != IntPtr.Zero && handle != new IntPtr(-1)) CloseHandle(handle);
    }

    [StructLayout(LayoutKind.Sequential)]
    private readonly record struct Coord(short X, short Y);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo
    {
        public int Cb;
        public string? Reserved;
        public string? Desktop;
        public string? Title;
        public int X;
        public int Y;
        public int XSize;
        public int YSize;
        public int XCountChars;
        public int YCountChars;
        public int FillAttribute;
        public int Flags;
        public short ShowWindow;
        public short Reserved2;
        public IntPtr Reserved2Pointer;
        public IntPtr StdInput;
        public IntPtr StdOutput;
        public IntPtr StdError;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfoEx
    {
        public StartupInfo StartupInfo;
        public IntPtr AttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation
    {
        public IntPtr Process;
        public IntPtr Thread;
        public int ProcessId;
        public int ThreadId;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CreatePipe(out IntPtr readPipe, out IntPtr writePipe, IntPtr pipeAttributes, int size);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool ReadFile(SafeFileHandle handle, byte[] buffer, int bytesToRead, out int bytesRead, IntPtr overlapped);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool InitializeProcThreadAttributeList(IntPtr attributeList, int count, int flags, ref IntPtr size);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool UpdateProcThreadAttribute(IntPtr attributeList, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previousValue, IntPtr returnSize);

    [DllImport("kernel32.dll")]
    private static extern void DeleteProcThreadAttributeList(IntPtr attributeList);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcess(
        string? applicationName,
        StringBuilder commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string currentDirectory,
        [In] ref StartupInfoEx startupInfo,
        out ProcessInformation processInformation);

    [DllImport("kernel32.dll", EntryPoint = "CreatePseudoConsole")]
    private static extern int CreatePseudoConsole(Coord size, SafeFileHandle input, SafeFileHandle output, uint flags, out IntPtr pseudoConsole);

    [DllImport("kernel32.dll", EntryPoint = "ResizePseudoConsole")]
    private static extern int ResizePseudoConsole(IntPtr pseudoConsole, Coord size);

    [DllImport("kernel32.dll", EntryPoint = "ClosePseudoConsole")]
    private static extern void ClosePseudoConsoleNative(IntPtr pseudoConsole);
}

internal static class NativeResult
{
    public static void ThrowIfFalse(this bool result, string operation)
    {
        if (!result) throw new Win32Exception(Marshal.GetLastWin32Error(), $"{operation} failed.");
    }
}
