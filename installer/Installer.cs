// Maana setup: a small guided installer for the browser extension.
// It copies the extension to a permanent folder and walks the user through the
// three steps Chromium browsers only allow a person to do (open the extensions
// page, switch on developer mode, load the folder).
//
// Built with the C# 5 compiler that ships with Windows, so no newer syntax here.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Text;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Markup;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using Microsoft.Win32;

[assembly: AssemblyTitle("Maana Setup")]
[assembly: AssemblyProduct("Maana")]
[assembly: AssemblyDescription("Installs the Maana translation extension")]
[assembly: AssemblyVersion("0.1.0.0")]
[assembly: AssemblyFileVersion("0.1.0.0")]

namespace MaanaSetup
{
    class Browser
    {
        public string Name;
        public string Exe;
        public string Url; // the address of its extensions page
    }

    class Options
    {
        public string Target;   // --target <dir>  : install somewhere else (tests)
        public string ShotDir;  // --shot <dir>    : render every page to PNG and exit (tests)
        public bool NoBrowser;  // --no-browser    : never launch a browser (tests)
        public string SelfTest; // --selftest <file>: click through every step and write what happened (tests)
    }

    static class Program
    {
        [STAThread]
        static void Main(string[] args)
        {
            Options o = new Options();
            for (int i = 0; i < args.Length; i++)
            {
                if (args[i] == "--target" && i + 1 < args.Length) o.Target = args[++i];
                else if (args[i] == "--shot" && i + 1 < args.Length) { o.ShotDir = args[++i]; o.NoBrowser = true; }
                else if (args[i] == "--no-browser") o.NoBrowser = true;
                else if (args[i] == "--selftest" && i + 1 < args.Length) { o.SelfTest = args[++i]; o.NoBrowser = true; }
            }
            Application app = new Application();
            Installer ins = new Installer(o);
            if (o.ShotDir != null || o.SelfTest != null)
            {
                // Test runs stay off the visible desktop.
                ins.Window.WindowStartupLocation = WindowStartupLocation.Manual;
                ins.Window.Left = -6000;
                ins.Window.Top = 0;
                ins.Window.ShowInTaskbar = false;
                ins.Window.ShowActivated = false;
                Action job = o.ShotDir != null ? new Action(ins.RunShots) : new Action(ins.RunSelfTest);
                ins.Window.Loaded += delegate { ins.Window.Dispatcher.BeginInvoke(DispatcherPriority.ApplicationIdle, job); };
            }
            app.Run(ins.Window);
        }
    }

    class Installer
    {
        public Window Window;

        const int Last = 5;
        static readonly string[] StepNames = { "نسخ الملفات", "صفحة الإضافات", "وضع المطوّر", "تحميل الإضافة", "جاهزة" };
        static readonly string[] Digits = { "١", "٢", "٣", "٤", "٥" };

        readonly Options opt;
        readonly FrameworkElement[] pages = new FrameworkElement[Last + 1];
        readonly List<Browser> browsers;
        Browser chosen;
        int step;
        string target;
        bool copied;

        StackPanel rail;
        Button btnNext, btnBack;
        TextBlock nextText, stepText;
        FrameworkElement nextArrow;

        public Installer(Options options)
        {
            opt = options;
            Window = (Window)XamlReader.Load(Resource("ui.xaml"));
            try { Window.Icon = BitmapFrame.Create(Resource("icon.png"), BitmapCreateOptions.None, BitmapCacheOption.OnLoad); }
            catch { }

            target = opt.Target ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Maana", "extension");
            for (int i = 0; i <= Last; i++) pages[i] = Find<FrameworkElement>("p" + i);
            rail = Find<StackPanel>("rail");
            btnNext = Find<Button>("btnNext");
            btnBack = Find<Button>("btnBack");
            nextText = Find<TextBlock>("nextText");
            nextArrow = Find<FrameworkElement>("nextArrow");
            stepText = Find<TextBlock>("stepText");

            string version = PayloadVersion();
            if (version.Length > 0) Find<TextBlock>("verText").Text = "التثبيت · " + version;

            Find<FrameworkElement>("titleBar").MouseLeftButtonDown += delegate(object s, MouseButtonEventArgs e)
            {
                if (e.ButtonState == MouseButtonState.Pressed) { try { Window.DragMove(); } catch { } }
            };
            Find<Button>("btnClose").Click += delegate { Window.Close(); };
            Find<Button>("btnMin").Click += delegate { Window.WindowState = WindowState.Minimized; };
            btnNext.Click += delegate { Next(); };
            btnBack.Click += delegate { Show(step - 1); };
            Find<Button>("btnOpenBrowser").Click += delegate { OpenBrowser(); };
            Find<Button>("btnCopyUrl").Click += delegate { Copy(ExtensionsUrl(), "copied2"); };
            Find<Button>("btnCopyPath").Click += delegate { Copy(target, "copied4"); };
            Window.KeyDown += delegate(object s, KeyEventArgs e) { if (e.Key == Key.Escape) Window.Close(); };

            browsers = FindBrowsers();
            BuildBrowserList();
            Show(0);
        }

        // ---------- pages ----------

        void Next()
        {
            if (step == Last) { Window.Close(); return; }
            if (step == 0 && !copied)
            {
                Show(1);
                Install();
                return;
            }
            Show(step + 1);
        }

        void Show(int i)
        {
            if (i < 0 || i > Last) return;
            step = i;
            for (int k = 0; k <= Last; k++) pages[k].Visibility = k == i ? Visibility.Visible : Visibility.Collapsed;

            btnBack.Visibility = i == 0 ? Visibility.Hidden : Visibility.Visible;
            nextText.Text = i == 0 ? "ابدأ التثبيت" : i == Last ? "إغلاق" : "التالي";
            nextArrow.Visibility = i == Last ? Visibility.Collapsed : Visibility.Visible;
            stepText.Text = i == 0 ? "" : "الخطوة " + Digits[i - 1] + " من " + Digits[Last - 1];
            btnNext.IsEnabled = i != 1 || copied;
            BuildRail();

            // Stay above the browser while the user follows the steps inside it.
            Window.Topmost = i >= 2 && i <= 4;

            if (i == 2)
            {
                Find<TextBlock>("urlText").Text = ExtensionsUrl();
                Find<Button>("btnOpenBrowser").Visibility = chosen == null ? Visibility.Collapsed : Visibility.Visible;
                Copy(ExtensionsUrl(), null);
            }
            if (i == 4)
            {
                Find<TextBlock>("pathText4").Text = target;
                Copy(target, null);
            }
            btnNext.Focus();
        }

        void BuildRail()
        {
            rail.Children.Clear();
            Brush gold = (Brush)Window.FindResource("Gold");
            Brush muted = (Brush)Window.FindResource("Muted");
            Brush text = (Brush)Window.FindResource("Text");
            Brush dim = new SolidColorBrush(Color.FromRgb(0x5D, 0x59, 0x4F));
            for (int k = 1; k <= Last; k++)
            {
                bool current = k == step;
                bool done = k < step || (k == 1 && copied && step != 1);

                Grid row = new Grid();
                row.Height = 40;
                row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(3) });
                row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(46) });
                row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
                if (current) row.Background = new SolidColorBrush(Color.FromRgb(0x19, 0x18, 0x16));

                Border bar = new Border();
                bar.Background = current ? gold : Brushes.Transparent;
                Grid.SetColumn(bar, 0);
                row.Children.Add(bar);

                FrameworkElement mark;
                if (done)
                {
                    System.Windows.Shapes.Path check = new System.Windows.Shapes.Path();
                    check.Data = Geometry.Parse("M0,5 L4,9 L11,0");
                    check.Stroke = gold;
                    check.StrokeThickness = 1.6;
                    check.FlowDirection = FlowDirection.LeftToRight;
                    mark = check;
                }
                else
                {
                    TextBlock num = new TextBlock();
                    num.Text = Digits[k - 1];
                    num.FontSize = 14;
                    num.Foreground = current ? gold : dim;
                    mark = num;
                }
                mark.HorizontalAlignment = HorizontalAlignment.Center;
                mark.VerticalAlignment = VerticalAlignment.Center;
                Grid.SetColumn(mark, 1);
                row.Children.Add(mark);

                TextBlock label = new TextBlock();
                label.Text = StepNames[k - 1];
                label.VerticalAlignment = VerticalAlignment.Center;
                label.Foreground = current ? text : done ? muted : dim;
                if (current) label.FontWeight = FontWeights.SemiBold;
                Grid.SetColumn(label, 2);
                row.Children.Add(label);

                rail.Children.Add(row);
            }
        }

        // ---------- step 1: copy the extension ----------

        void Install()
        {
            TextBlock status = Find<TextBlock>("copyStatus");
            TextBlock error = Find<TextBlock>("copyError");
            Find<TextBlock>("pathText").Text = target;
            error.Visibility = Visibility.Collapsed;
            try
            {
                Extract();
                copied = true;
                status.Text = "تم. ملفات الإضافة صارت في هالمجلد:";
            }
            catch (Exception ex)
            {
                copied = false;
                status.Text = "ما قدرت أنسخ الملفات.";
                error.Text = "السبب: " + ex.Message + "  سكّر المتصفح وجرّب مرة ثانية.";
                error.Visibility = Visibility.Visible;
            }
            Show(1);
        }

        void Extract()
        {
            string root = Path.GetFullPath(target);
            if (Directory.Exists(root))
            {
                // An update: clear the old copy so removed files do not linger.
                foreach (string f in Directory.GetFiles(root)) File.Delete(f);
                foreach (string d in Directory.GetDirectories(root)) Directory.Delete(d, true);
            }
            Directory.CreateDirectory(root);
            string prefix = root.EndsWith(Path.DirectorySeparatorChar.ToString()) ? root : root + Path.DirectorySeparatorChar;
            using (ZipArchive zip = new ZipArchive(Resource("payload.zip"), ZipArchiveMode.Read))
            {
                foreach (ZipArchiveEntry entry in zip.Entries)
                {
                    string dest = Path.GetFullPath(Path.Combine(root, entry.FullName));
                    if (!dest.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) continue; // never write outside the folder
                    if (entry.FullName.EndsWith("/") || entry.FullName.EndsWith("\\"))
                    {
                        Directory.CreateDirectory(dest);
                        continue;
                    }
                    Directory.CreateDirectory(Path.GetDirectoryName(dest));
                    using (Stream src = entry.Open())
                    using (FileStream dst = new FileStream(dest, FileMode.Create, FileAccess.Write))
                    {
                        src.CopyTo(dst);
                    }
                }
            }
            if (!File.Exists(Path.Combine(root, "manifest.json"))) throw new IOException("manifest.json missing after copy");
        }

        string PayloadVersion()
        {
            try
            {
                using (ZipArchive zip = new ZipArchive(Resource("payload.zip"), ZipArchiveMode.Read))
                {
                    ZipArchiveEntry m = zip.GetEntry("manifest.json");
                    if (m == null) return "";
                    using (StreamReader r = new StreamReader(m.Open(), Encoding.UTF8))
                    {
                        string json = r.ReadToEnd();
                        int at = json.IndexOf("\"version\"");
                        if (at < 0) return "";
                        int q1 = json.IndexOf('"', json.IndexOf(':', at) + 1);
                        int q2 = json.IndexOf('"', q1 + 1);
                        return q1 > 0 && q2 > q1 ? json.Substring(q1 + 1, q2 - q1 - 1) : "";
                    }
                }
            }
            catch { return ""; }
        }

        // ---------- browsers ----------

        static List<Browser> FindBrowsers()
        {
            string pf = Environment.GetEnvironmentVariable("ProgramFiles") ?? "";
            string pf86 = Environment.GetEnvironmentVariable("ProgramFiles(x86)") ?? "";
            string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            string[][] known =
            {
                new[] { "Google Chrome", "chrome.exe", "chrome://extensions", @"Google\Chrome\Application\chrome.exe" },
                new[] { "Microsoft Edge", "msedge.exe", "edge://extensions", @"Microsoft\Edge\Application\msedge.exe" },
                new[] { "Brave", "brave.exe", "brave://extensions", @"BraveSoftware\Brave-Browser\Application\brave.exe" },
                new[] { "Vivaldi", "vivaldi.exe", "vivaldi://extensions", @"Vivaldi\Application\vivaldi.exe" },
                new[] { "Opera", "opera.exe", "opera://extensions", @"Programs\Opera\opera.exe" },
            };
            List<Browser> found = new List<Browser>();
            foreach (string[] k in known)
            {
                string exe = AppPath(k[1]) ?? RegisteredBrowser(k[1]);
                if (exe == null)
                {
                    foreach (string baseDir in new[] { pf, pf86, local })
                    {
                        if (baseDir.Length == 0) continue;
                        string p = Path.Combine(baseDir, k[3]);
                        if (File.Exists(p)) { exe = p; break; }
                    }
                }
                if (exe != null) found.Add(new Browser { Name = k[0], Exe = exe, Url = k[2] });
            }
            return found;
        }

        static string AppPath(string exeName)
        {
            string key = @"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\" + exeName;
            foreach (RegistryHive hive in new[] { RegistryHive.CurrentUser, RegistryHive.LocalMachine })
            {
                foreach (RegistryView view in new[] { RegistryView.Registry64, RegistryView.Registry32 })
                {
                    try
                    {
                        using (RegistryKey root = RegistryKey.OpenBaseKey(hive, view))
                        using (RegistryKey k = root.OpenSubKey(key))
                        {
                            if (k == null) continue;
                            string v = k.GetValue(null) as string;
                            if (v == null) continue;
                            v = v.Trim('"');
                            if (File.Exists(v)) return v;
                        }
                    }
                    catch { }
                }
            }
            return null;
        }

        // Browsers also register themselves under "StartMenuInternet"; this catches
        // installs in unusual folders.
        static string RegisteredBrowser(string exeName)
        {
            foreach (RegistryHive hive in new[] { RegistryHive.CurrentUser, RegistryHive.LocalMachine })
            {
                foreach (RegistryView view in new[] { RegistryView.Registry64, RegistryView.Registry32 })
                {
                    try
                    {
                        using (RegistryKey root = RegistryKey.OpenBaseKey(hive, view))
                        using (RegistryKey list = root.OpenSubKey(@"SOFTWARE\Clients\StartMenuInternet"))
                        {
                            if (list == null) continue;
                            foreach (string name in list.GetSubKeyNames())
                            {
                                using (RegistryKey cmd = list.OpenSubKey(name + @"\shell\open\command"))
                                {
                                    string v = cmd == null ? null : cmd.GetValue(null) as string;
                                    if (v == null) continue;
                                    v = v.Trim().Trim('"');
                                    if (v.EndsWith("\\" + exeName, StringComparison.OrdinalIgnoreCase) && File.Exists(v)) return v;
                                }
                            }
                        }
                    }
                    catch { }
                }
            }
            return null;
        }

        void BuildBrowserList()
        {
            StackPanel list = Find<StackPanel>("browserList");
            if (browsers.Count == 0)
            {
                Find<TextBlock>("noBrowser").Visibility = Visibility.Visible;
                return;
            }
            Style style = (Style)Window.FindResource("Choice");
            for (int i = 0; i < browsers.Count; i++)
            {
                Browser b = browsers[i];
                RadioButton r = new RadioButton();
                r.Style = style;
                r.GroupName = "browser";
                r.Content = b.Name;
                r.Checked += delegate { chosen = b; };
                list.Children.Add(r);
                if (i == 0) r.IsChecked = true;
            }
        }

        string ExtensionsUrl()
        {
            return chosen != null ? chosen.Url : "chrome://extensions";
        }

        void OpenBrowser()
        {
            if (chosen == null || opt.NoBrowser) return;
            // Browsers ignore their own internal addresses when given on the command
            // line, so just bring the browser up; the address is on the clipboard.
            try { Process.Start(new ProcessStartInfo(chosen.Exe) { UseShellExecute = true }); }
            catch { }
        }

        // ---------- helpers ----------

        void Copy(string value, string confirmName)
        {
            if (opt.ShotDir != null) return; // test renders must not touch the clipboard
            bool ok = false;
            for (int attempt = 0; attempt < 4 && !ok; attempt++)
            {
                try { Clipboard.SetDataObject(value, true); ok = true; }
                catch { System.Threading.Thread.Sleep(60); }
            }
            if (confirmName == null || !ok) return;
            TextBlock mark = Find<TextBlock>(confirmName);
            mark.Visibility = Visibility.Visible;
            DispatcherTimer t = new DispatcherTimer();
            t.Interval = TimeSpan.FromSeconds(1.6);
            t.Tick += delegate { mark.Visibility = Visibility.Hidden; t.Stop(); };
            t.Start();
        }

        T Find<T>(string name) where T : class
        {
            T el = Window.FindName(name) as T;
            if (el == null) throw new InvalidOperationException("missing element: " + name);
            return el;
        }

        static Stream Resource(string name)
        {
            Stream s = Assembly.GetExecutingAssembly().GetManifestResourceStream(name);
            if (s == null) throw new InvalidOperationException("missing resource: " + name);
            return s;
        }

        // ---------- test mode: render every page to a PNG ----------

        public void RunShots()
        {
            try
            {
                Directory.CreateDirectory(opt.ShotDir);
                for (int i = 0; i <= Last; i++)
                {
                    if (i == 1) Install();
                    else Show(i);
                    Window.Topmost = false;
                    Window.UpdateLayout();
                    Window.Dispatcher.Invoke(DispatcherPriority.ApplicationIdle, new Action(delegate { }));
                    Save(Path.Combine(opt.ShotDir, "installer-" + i + ".png"));
                }
                File.WriteAllText(Path.Combine(opt.ShotDir, "installer-result.txt"),
                    "copied=" + copied + "\r\ntarget=" + target + "\r\nbrowsers=" + browsers.Count + "\r\n", Encoding.UTF8);
            }
            catch (Exception ex)
            {
                File.WriteAllText(Path.Combine(opt.ShotDir, "installer-result.txt"), "ERROR " + ex, Encoding.UTF8);
            }
            Window.Close();
        }

        // Presses the real buttons one after another and records the outcome.
        public void RunSelfTest()
        {
            StringBuilder log = new StringBuilder();
            string before = null;
            try { if (Clipboard.ContainsText()) before = Clipboard.GetText(); } catch { }
            try
            {
                Action<Button> click = delegate(Button b) { b.RaiseEvent(new RoutedEventArgs(Button.ClickEvent)); };
                Func<string> clip = delegate { try { return Clipboard.GetText(); } catch { return "(clipboard busy)"; } };

                log.AppendLine("start step=" + step + " next=" + nextText.Text);
                click(btnNext);
                log.AppendLine("after next: step=" + step + " copied=" + copied + " manifest=" + File.Exists(Path.Combine(target, "manifest.json")));
                click(btnNext);
                log.AppendLine("step=" + step + " topmost=" + Window.Topmost + " clipboard=" + clip());
                click(Find<Button>("btnOpenBrowser"));
                click(btnNext);
                log.AppendLine("step=" + step + " topmost=" + Window.Topmost);
                click(btnNext);
                log.AppendLine("step=" + step + " clipboard-is-target=" + (clip() == target));
                click(btnBack);
                log.AppendLine("after back: step=" + step);
                click(btnNext);
                click(btnNext);
                log.AppendLine("step=" + step + " next=" + nextText.Text + " topmost=" + Window.Topmost);
                log.AppendLine("OK");
            }
            catch (Exception ex)
            {
                log.AppendLine("ERROR " + ex);
            }
            try { if (before != null) Clipboard.SetDataObject(before, true); else Clipboard.Clear(); } catch { }
            File.WriteAllText(opt.SelfTest, log.ToString(), Encoding.UTF8);
            Window.Close();
        }

        void Save(string file)
        {
            FrameworkElement root = (FrameworkElement)Window.Content;
            double scale = 1.5;
            int w = (int)Math.Ceiling(root.ActualWidth * scale);
            int h = (int)Math.Ceiling(root.ActualHeight * scale);
            DrawingVisual dv = new DrawingVisual();
            using (DrawingContext dc = dv.RenderOpen())
            {
                dc.DrawRectangle(Window.Background, null, new Rect(0, 0, w, h));
                // The window lays out right-to-left; mirror back so the picture matches the screen.
                dc.PushTransform(new MatrixTransform(-scale, 0, 0, scale, w, 0));
                dc.DrawRectangle(new VisualBrush(root) { Stretch = Stretch.None, AlignmentX = AlignmentX.Left, AlignmentY = AlignmentY.Top }, null,
                    new Rect(0, 0, root.ActualWidth, root.ActualHeight));
                dc.Pop();
            }
            RenderTargetBitmap bmp = new RenderTargetBitmap(w, h, 96, 96, PixelFormats.Pbgra32);
            bmp.Render(dv);
            PngBitmapEncoder enc = new PngBitmapEncoder();
            enc.Frames.Add(BitmapFrame.Create(bmp));
            using (FileStream fs = new FileStream(file, FileMode.Create)) enc.Save(fs);
        }
    }
}
