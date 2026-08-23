using System.ComponentModel;
using System.Drawing;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Forms;
using System.Windows.Input;

namespace MiraBridge.Windows;

public partial class MainWindow : Window
{
    private readonly MainViewModel _viewModel;
    private readonly NotifyIcon _tray;
    private readonly bool _startInTray;
    private bool _exitRequested;

    public MainWindow()
        : this((System.Windows.Application.Current as App)?.StartInTray ?? false)
    {
    }

    internal MainWindow(bool startInTray)
    {
        _startInTray = startInTray;
        _viewModel = new MainViewModel(new WindowsOperations());
        InitializeComponent();
        DataContext = _viewModel;
        LanguageSelector.SelectionChanged += LanguageChanged;
        System.Drawing.Icon? appIcon = System.Drawing.Icon.ExtractAssociatedIcon(Environment.ProcessPath ?? string.Empty);
        _tray = new NotifyIcon
        {
            Text = "MiraBridge for Windows",
            Icon = appIcon ?? SystemIcons.Application,
            Visible = true,
            ContextMenuStrip = BuildTrayMenu()
        };
        _viewModel.PropertyChanged += (_, eventArgs) =>
        {
            if (eventArgs.PropertyName == nameof(MainViewModel.Status))
                _tray.Text = _viewModel.Status == "Ready" ? "MiraBridge — Ready" : "MiraBridge — Needs Attention";
        };
        _tray.DoubleClick += (_, _) => ShowFromTray();
        Loaded += async (_, _) =>
        {
            if (_startInTray) Hide();
            await _viewModel.InitializeAsync();
            _tray.Text = _viewModel.Status == "Ready" ? "MiraBridge — Ready" : "MiraBridge — Needs Attention";
        };
    }

    protected override void OnClosing(CancelEventArgs eventArgs)
    {
        if (!_exitRequested)
        {
            eventArgs.Cancel = true;
            Hide();
            return;
        }
        _tray.Visible = false;
        _tray.Dispose();
        base.OnClosing(eventArgs);
    }

    private ContextMenuStrip BuildTrayMenu()
    {
        var menu = new ContextMenuStrip();
        menu.Items.Add("Open MiraBridge / 打开", null, (_, _) => ShowFromTray());
        menu.Items.Add("Exit / 退出", null, (_, _) =>
        {
            _exitRequested = true;
            Close();
        });
        return menu;
    }

    internal void ShowFromTray()
    {
        Show();
        WindowState = WindowState.Normal;
        Activate();
        Focus();
    }

    private void TitleBar_MouseLeftButtonDown(object sender, MouseButtonEventArgs eventArgs)
    {
        if (eventArgs.ChangedButton != MouseButton.Left) return;
        if (eventArgs.ClickCount == 2)
        {
            WindowState = WindowState == WindowState.Maximized ? WindowState.Normal : WindowState.Maximized;
            return;
        }
        DragMove();
    }

    private void Minimize_Click(object sender, RoutedEventArgs eventArgs) => WindowState = WindowState.Minimized;

    private void MaximizeRestore_Click(object sender, RoutedEventArgs eventArgs) =>
        WindowState = WindowState == WindowState.Maximized ? WindowState.Normal : WindowState.Maximized;

    private void Close_Click(object sender, RoutedEventArgs eventArgs) => Close();

    private void NavigateToPairing_Click(object sender, RoutedEventArgs eventArgs)
    {
        Navigation.SelectedIndex = 1;
    }

    private void LanguageChanged(object sender, SelectionChangedEventArgs eventArgs)
    {
        if (sender is not System.Windows.Controls.ComboBox { SelectedItem: System.Windows.Controls.ComboBoxItem item } || item.Tag is not string language) return;
        var dictionary = new ResourceDictionary { Source = new Uri($"Resources/Strings.{language}.xaml", UriKind.Relative) };
        var dictionaries = System.Windows.Application.Current.Resources.MergedDictionaries;
        if (dictionaries.Count > 0) dictionaries[0] = dictionary;
        else dictionaries.Add(dictionary);
        _viewModel.Language = language;
    }
}
