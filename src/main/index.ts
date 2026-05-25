import { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, shell } from "electron";
import path from "node:path";
import { DatabaseService } from "./database";
import { ConfigService } from "./config";
import { CommunityService, GetCurrentWeekId } from "./community";
import { UpdateService } from "./updateService";
import { Analyze as AiAnalyze } from "./ai-service";

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let databaseService: DatabaseService | null = null;
let configService: ConfigService | null = null;
let communityService: CommunityService | null = null;
let updateService: UpdateService | null = null;
let isQuitting: boolean = false;

const IS_DEV: boolean = process.env.ELECTRON_RENDERER_URL !== undefined;

// 创建窗口时不显示，等 ready-to-show 再显示，避免白屏闪烁
function CreateWindow(): void {
    const preloadPath: string = path.join(__dirname, "../preload/index.cjs");
    console.log("[Main] Creating window, preload path:", preloadPath);
    console.log("[Main] __dirname:", __dirname);
    console.log("[Main] Dev mode:", IS_DEV);

    const iconPath: string = path.join(__dirname, "../../resources/stopwatch.png");

    mainWindow = new BrowserWindow({
        width: 960,
        height: 680,
        minWidth: 800,
        minHeight: 600,
        backgroundColor: "#f5f5f5",
        show: false,
        icon: iconPath,
        webPreferences: {
            preload: preloadPath,
            contextIsolation: true,
            nodeIntegration: false,
        },
    });

    // 隐藏菜单栏（仅在开发模式下显示）
    if (!IS_DEV) {
        mainWindow.setMenuBarVisibility(false);
    }

    mainWindow.once("ready-to-show", () => {
        console.log("[Main] Window ready-to-show");
        mainWindow?.show();
        // 开发模式自动打开 DevTools
        if (IS_DEV) {
            mainWindow?.webContents.openDevTools();
            console.log("[Main] DevTools opened");
        }
    });

    // 监听页面加载错误
    mainWindow.webContents.on("did-fail-load", (..._args) => {
        const errorCode: number = _args[1] as number;
        const errorDescription: string = _args[2] as string;
        console.error("[Main] Page load failed:", errorCode, errorDescription);
    });

    // 监听控制台消息（渲染进程 console 会转发到这里）
    mainWindow.webContents.on("console-message", (..._args) => {
        const level: number = _args[1] as number;
        const message: string = _args[2] as string;
        const levelNames: string[] = ["verbose", "info", "warning", "error"];
        console.log(`[Renderer ${levelNames[level] ?? level}]`, message);
    });

    // 开发环境加载 dev server URL，生产环境加载打包后的文件
    if (IS_DEV) {
        console.log("[Main] Loading dev URL:", process.env.ELECTRON_RENDERER_URL);
        mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL!);
    } else {
        const filePath: string = path.join(__dirname, "../renderer/index.html");
        console.log("[Main] Loading file:", filePath);
        mainWindow.loadFile(filePath);
    }

    // 关闭窗口时缩到托盘而不是退出
    mainWindow.on("close", (event) => {
        if (tray !== null && !isQuitting) {
            event.preventDefault();
            mainWindow?.hide();
        }
    });
}

function CreateTray(): void {
    const iconPath: string = path.join(__dirname, "../../resources/stopwatch.png");
    const icon: Electron.NativeImage = nativeImage.createFromPath(iconPath);

    tray = new Tray(icon);
    tray.setToolTip("牛子小助手");

    const contextMenu = Menu.buildFromTemplate([
        {
            label: "显示",
            click: (): void => {
                mainWindow?.show();
            },
        },
        {
            label: "退出",
            click: (): void => {
                isQuitting = true;
                tray = null;
                app.quit();
            },
        },
    ]);

    tray.setContextMenu(contextMenu);

    tray.on("double-click", () => {
        mainWindow?.show();
    });
}

function RegisterIpcHandlers(): void {
    if (!databaseService) {
        console.error("[Main] databaseService is null, skipping IPC registration");
        return;
    }
    console.log("[Main] Registering IPC handlers...");

    ipcMain.handle("records:get-all", () => {
        return databaseService!.GetRecords();
    });

    ipcMain.handle("records:save", (...args) => {
        const startTime: string = args[1] as string;
        const endTime: string = args[2] as string;
        const duration: number = args[3] as number;
        const notes: string | undefined = args[4] as string | undefined;
        const record = databaseService!.SaveRecord(new Date(startTime), new Date(endTime), duration, notes);
        // 通知渲染进程数据已更新
        mainWindow?.webContents.send("records-updated");
        return record;
    });

    ipcMain.handle("records:delete", (...args) => {
        const id: string = args[1] as string;
        const success = databaseService!.DeleteRecord(id);
        if (success) {
            mainWindow?.webContents.send("records-updated");
        }
        return success;
    });

    ipcMain.handle("records:clear-all", () => {
        databaseService!.ClearAll();
        mainWindow?.webContents.send("records-updated");
    });

    ipcMain.handle("records:get-stats", () => {
        return databaseService!.GetStats();
    });

    ipcMain.handle("records:get-daily-counts", (...args) => {
        const startTimestamp: number = args[1] as number;
        const endTimestamp: number = args[2] as number;
        return databaseService!.GetDailyCounts(startTimestamp, endTimestamp);
    });

    ipcMain.handle("records:import", (...args) => {
        const records = args[1] as { Id: string; StartTime?: string; EndTime?: string; Duration: number; Notes?: string }[];
        const result = databaseService!.ImportRecords(records);
        if (result.Imported > 0) {
            mainWindow?.webContents.send("records-updated");
        }
        return result;
    });

    // 配置相关
    ipcMain.handle("config:get", () => {
        return configService!.GetConfig();
    });

    ipcMain.handle("config:set", (...args) => {
        const partial = args[1] as { CommunityOptIn?: boolean };
        return configService!.SetConfig(partial);
    });

    // 社区统计相关
    ipcMain.handle("community:get-stats", async () => {
        const weekId: string = GetCurrentWeekId();
        return communityService!.GetCommunityStats(weekId);
    });

    ipcMain.handle("community:submit", async () => {
        const config = configService!.GetConfig();
        if (!config.CommunityOptIn || config.ContributorId === null) {
            return false;
        }
        const weeklyStats = databaseService!.GetWeeklyStats();
        const weekId: string = GetCurrentWeekId();
        return communityService!.SubmitStats(
            config.ContributorId,
            weekId,
            weeklyStats.Count,
            weeklyStats.AvgDuration
        );
    });

    ipcMain.handle("updates:get-state", () => {
        return updateService!.GetState();
    });

    ipcMain.handle("updates:get-settings", () => {
        return updateService!.GetSettings();
    });

    ipcMain.handle("updates:set-source", (_event, source: string) => {
        return updateService!.SetSource(source);
    });

    ipcMain.handle("updates:check", () => {
        return updateService!.CheckForUpdates();
    });

    ipcMain.handle("updates:download", () => {
        return updateService!.DownloadUpdate();
    });

    ipcMain.handle("updates:install", () => {
        isQuitting = true;
        updateService!.InstallUpdate();
    });

    ipcMain.handle("shell:open-external", (_event, url: string) => {
        return shell.openExternal(url);
    });

    ipcMain.handle("charts:hourly-distribution", () => {
        return databaseService!.GetHourlyDistribution();
    });

    ipcMain.handle("charts:weekday-distribution", () => {
        return databaseService!.GetWeekdayDistribution();
    });

    ipcMain.handle("charts:monthly-trend", () => {
        return databaseService!.GetMonthlyTrend();
    });

    ipcMain.handle("charts:duration-distribution", () => {
        return databaseService!.GetAllDurations();
    });

    // 设置通道（API Key 使用系统加密存储，仅允许白名单内的 key）
    const ALLOWED_SETTINGS: Set<string> = new Set([
        "ai_provider", "ai_api_key", "ai_api_endpoint", "ai_model",
    ]);

    ipcMain.handle("settings:get", (...args) => {
        const key: unknown = args[1];
        if (typeof key !== "string" || !ALLOWED_SETTINGS.has(key)) {
            throw new Error(`不允许的设置项: ${String(key)}`);
        }
        if (key === "ai_api_key") {
            return databaseService!.GetSecureSetting(key);
        }
        return databaseService!.GetSetting(key);
    });

    ipcMain.handle("settings:set", (...args) => {
        const key: unknown = args[1];
        const value: unknown = args[2];
        if (typeof key !== "string" || typeof value !== "string" || !ALLOWED_SETTINGS.has(key)) {
            throw new Error(`不允许的设置项: ${String(key)}`);
        }
        if (key === "ai_api_key") {
            databaseService!.SetSecureSetting(key, value);
        } else {
            databaseService!.SetSetting(key, value);
        }
    });

    ipcMain.handle("ai:analyze", async () => {
        const db = databaseService!;
        const stats = db.GetStats();
        const hourly = db.GetHourlyDistribution();
        const weekday = db.GetWeekdayDistribution();
        const monthly = db.GetMonthlyTrend();
        const durations = db.GetAllDurations();

        const sorted = [...durations].sort((a, b) => a - b);
        const mid: number = Math.floor(sorted.length / 2);
        const median: number = sorted.length === 0
            ? 0
            : sorted.length % 2 !== 0
                ? sorted[mid]!
                : (sorted[mid - 1]! + sorted[mid]!) / 2;
        const durationStats = {
            Min: sorted[0] ?? 0,
            Max: sorted[sorted.length - 1] ?? 0,
            Avg: stats.AverageDuration,
            Median: median,
        };

        const rawProvider: string = db.GetSetting("ai_provider") ?? "local";
        const provider: "openai" | "local" = rawProvider === "openai" ? "openai" : "local";
        const config = {
            Provider: provider,
            ApiKey: db.GetSecureSetting("ai_api_key") ?? "",
            ApiEndpoint: db.GetSetting("ai_api_endpoint") ?? "https://api.openai.com/v1/chat/completions",
            Model: db.GetSetting("ai_model") ?? "gpt-4o-mini",
        };

        try {
            return await AiAnalyze(
                { ...stats, HourlyDistribution: hourly, WeekdayDistribution: weekday, MonthlyTrend: monthly, DurationStats: durationStats },
                config
            );
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : "分析失败";
            throw new Error(message.length > 200 ? message.slice(0, 200) + "..." : message);
        }
    });
}

// 单例锁：禁止多个实例，防止多个托盘图标
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
    console.log("[Main] Another instance is running, quitting");
    app.quit();
} else {
    app.on("second-instance", () => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) {
                mainWindow.restore();
            }
            mainWindow.show();
            mainWindow.focus();
        }
    });

    app.whenReady().then(async () => {
        console.log("[Main] App ready");
        databaseService = await DatabaseService.create();
        console.log("[Main] DatabaseService initialized");
        configService = new ConfigService();
        communityService = new CommunityService(configService.GetConfig().ApiEndpoint);
        console.log("[Main] ConfigService & CommunityService initialized");
        updateService = new UpdateService(() => mainWindow);
        RegisterIpcHandlers();
        CreateWindow();
        CreateTray();
        updateService.StartStartupCheck();
        console.log("[Main] Startup complete");

        app.on("activate", () => {
            if (BrowserWindow.getAllWindows().length === 0) {
                CreateWindow();
            } else {
                mainWindow?.show();
            }
        });
    });
}

// 所有窗口关闭时退出（除了 macOS）
app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
        // 不自动退出，托盘维持运行
    }
});

app.on("before-quit", () => {
    isQuitting = true;
    tray = null;
    databaseService?.Close();
});
