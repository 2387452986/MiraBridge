using System.Windows;
using System.Windows.Interop;
using System.Windows.Media;

namespace MiraBridge.Windows;

public partial class App : System.Windows.Application
{
    public App()
        : this(startInTray: false)
    {
    }

    public App(bool startInTray)
    {
        RenderOptions.ProcessRenderMode = RenderMode.SoftwareOnly;
        StartInTray = startInTray;
    }

    public bool StartInTray { get; }
}
