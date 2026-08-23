using System.Windows;

namespace MiraBridge.Windows;

public partial class App : System.Windows.Application
{
    public App()
    {
    }

    public App(bool startInTray)
    {
        StartInTray = startInTray;
    }

    public bool StartInTray { get; }
}
