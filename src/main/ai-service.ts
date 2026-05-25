// AI 分析服务：OpenAI Chat v1 Completions 兼容接口 + 本地规则

interface IAiAnalysisData {
    TotalCount: number;
    AverageDuration: number;
    FrequencyPerWeek: number;
    FrequencyPerMonth: number;
    HourlyDistribution: { Hour: number; Count: number }[];
    WeekdayDistribution: { Weekday: number; Count: number }[];
    MonthlyTrend: { Month: string; Count: number }[];
    DurationStats: { Min: number; Max: number; Avg: number; Median: number };
}

export interface IAiConfig {
    Provider: "openai" | "local";
    ApiEndpoint: string;
    ApiKey: string;
    Model: string;
}

const WEEKDAY_NAMES: string[] = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const FETCH_TIMEOUT_MS: number = 30_000;

const BuildPrompt = (data: IAiAnalysisData): string => {
    const hourlyPeaks = [...data.HourlyDistribution]
        .sort((a, b) => b.Count - a.Count)
        .slice(0, 3);

    return `你是一个健康数据分析助手。请基于以下统计数据，给出简洁的分析和建议（中文回答，200字以内）：

统计概览：
- 总次数：${data.TotalCount}
- 平均时长：${data.AverageDuration.toFixed(1)} 分钟
- 本周频率：${data.FrequencyPerWeek} 次
- 本月频率：${data.FrequencyPerMonth} 次

高峰时段（前3）：
${hourlyPeaks.map((h) => `- ${h.Hour}:00：${h.Count} 次`).join("\n")}

星期分布：
${data.WeekdayDistribution.map((d) => `- ${WEEKDAY_NAMES[d.Weekday] ?? "?"}：${d.Count} 次`).join("\n")}

时长统计：
- 最短：${data.DurationStats.Min.toFixed(1)} 分钟
- 最长：${data.DurationStats.Max.toFixed(1)} 分钟
- 中位数：${data.DurationStats.Median.toFixed(1)} 分钟

月度趋势（最近数月）：
${data.MonthlyTrend.slice(-6).map((m) => `- ${m.Month}：${m.Count} 次`).join("\n")}

请分析：1. 行为模式特点 2. 频率是否健康 3. 简短建议`;
};

const FetchWithTimeout = (url: string, options: RequestInit): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
};

const ExtractOpenAiText = (result: unknown): string => {
    const body = result as Record<string, unknown> | null;
    if (body === null || typeof body !== "object") throw new Error("API 返回格式异常");
    const choices = body.choices;
    if (!Array.isArray(choices) || choices.length === 0) throw new Error("API 返回内容为空");
    const first = choices[0] as Record<string, unknown> | undefined;
    if (first === undefined || typeof first !== "object") throw new Error("API 返回格式异常");
    const message = (first as Record<string, unknown>).message as Record<string, unknown> | undefined;
    if (message === undefined || typeof message.content !== "string") throw new Error("API 返回格式异常");
    return message.content;
};

const AnalyzeWithApi = async (data: IAiAnalysisData, config: IAiConfig): Promise<string> => {
    const response = await FetchWithTimeout(config.ApiEndpoint, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.ApiKey}`,
        },
        body: JSON.stringify({
            model: config.Model,
            messages: [{ role: "user", content: BuildPrompt(data) }],
            max_tokens: 1024,
        }),
    });
    if (!response.ok) {
        throw new Error(`API 错误: ${response.status}`);
    }
    return ExtractOpenAiText(await response.json());
};

const AnalyzeLocally = (data: IAiAnalysisData): string => {
    if (data.TotalCount === 0) {
        return "暂无数据记录，开始记录后即可获得分析洞察。";
    }

    const insights: string[] = [];

    const peakHours = [...data.HourlyDistribution]
        .filter((h) => h.Count > 0)
        .sort((a, b) => b.Count - a.Count);
    if (peakHours.length > 0) {
        const top = peakHours[0]!;
        const period = top.Hour < 6 ? "凌晨" : top.Hour < 12 ? "上午" : top.Hour < 18 ? "下午" : "晚上";
        insights.push(`📍 高峰时段集中在${period} ${top.Hour}:00 左右（${top.Count} 次）。`);
    }

    const peakDay = data.WeekdayDistribution.reduce(
        (max, d) => (d.Count > max.Count ? d : max),
        data.WeekdayDistribution[0]!
    );
    if (peakDay.Count > 0) {
        insights.push(`📅 ${WEEKDAY_NAMES[peakDay.Weekday] ?? "?"}是最活跃的一天（${peakDay.Count} 次）。`);
    }

    const weeklyAvg: number = data.FrequencyPerMonth / 4;
    if (weeklyAvg <= 3) {
        insights.push(`✅ 周均频率约 ${weeklyAvg.toFixed(1)} 次，频率适中。`);
    } else if (weeklyAvg <= 7) {
        insights.push(`⚠️ 周均频率约 ${weeklyAvg.toFixed(1)} 次，频率偏高，建议适当控制。`);
    } else {
        insights.push(`🔴 周均频率约 ${weeklyAvg.toFixed(1)} 次，频率较高，建议关注身体状况。`);
    }

    if (data.DurationStats.Avg > 0) {
        insights.push(`⏱️ 平均时长 ${data.DurationStats.Avg.toFixed(1)} 分钟，中位数 ${data.DurationStats.Median.toFixed(1)} 分钟。`);
    }

    const recentMonths = data.MonthlyTrend.slice(-3);
    if (recentMonths.length >= 2) {
        const last = recentMonths[recentMonths.length - 1]!;
        const prev = recentMonths[recentMonths.length - 2]!;
        if (last.Count > prev.Count) {
            insights.push(`📈 近期趋势上升：本月（${last.Count} 次）比上月（${prev.Count} 次）增加。`);
        } else if (last.Count < prev.Count) {
            insights.push(`📉 近期趋势下降：本月（${last.Count} 次）比上月（${prev.Count} 次）减少。`);
        } else {
            insights.push(`➡️ 近期趋势稳定，最近两个月均为 ${last.Count} 次。`);
        }
    }

    return insights.join("\n\n");
};

export const Analyze = async (data: IAiAnalysisData, config: IAiConfig): Promise<string> => {
    if (config.Provider === "local") {
        return AnalyzeLocally(data);
    }
    return AnalyzeWithApi(data, config);
};
