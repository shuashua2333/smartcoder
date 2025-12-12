const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
const PORT = 3000;

// 允许跨域（这很重要，否则网页和插件都连不上）
app.use(cors());
app.use(bodyParser.json());

// --- 核心逻辑：内存数据库 ---
// 存储所有提交记录的数组，用于计算性能排名
// 演示结束后重启服务器就会清空，非常适合大作业
let submissions = [];

// 计算击败率：返回当前值击败了多少百分比的历史记录
// 对于 runtime：越小越好（击败了更大值的）
// 对于 memory：越小越好（击败了更大值的）
function calculateBeatPercentage(value, allValues, isBetterLower = true) {
    if (allValues.length === 0 || value < 0) {
        return null; // 如果没有历史数据或当前值无效，返回 null
    }
    
    // 过滤掉无效值（-1 表示失败）
    const validValues = allValues.filter(v => v >= 0);
    if (validValues.length === 0) {
        return null;
    }
    
    // 计算击败了多少个值
    let beatCount = 0;
    if (isBetterLower) {
        // 值越小越好（如 runtime, memory）
        beatCount = validValues.filter(v => v > value).length;
    } else {
        // 值越大越好（如分数）
        beatCount = validValues.filter(v => v < value).length;
    }
    
    // 计算百分比（四舍五入到整数）
    return Math.round((beatCount / validValues.length) * 100);
}

// 1. 接收来自 VS Code 的提交（包含性能数据）
app.post('/api/submit', (req, res) => {
    const { code, problemId, output, runtime, memory, timestamp } = req.body;
    console.log(`[Server] 收到来自 VS Code 的提交: 题目ID=${problemId}`);
    
    const currentRuntime = runtime !== undefined ? runtime : -1;
    const currentMemory = memory !== undefined ? memory : -1;
    
    if (currentRuntime >= 0 && currentMemory >= 0) {
        console.log(`[Server] 性能数据 - 运行时间: ${currentRuntime}ms, 内存: ${currentMemory} bytes`);
    }
    
    // 创建新的提交记录
    const newSubmission = {
        code,
        problemId,
        output: output || '',
        runtime: currentRuntime,
        memory: currentMemory,
        timestamp: timestamp || Date.now(),
        status: 'pending' // 待网页端处理
    };
    
    // 将新提交添加到数组
    submissions.push(newSubmission);
    console.log(`[Server] 当前总提交数: ${submissions.length}`);
    
    // 计算性能排名（击败率）
    // 获取所有历史提交的 runtime 和 memory 值（包括当前提交）
    const allRuntimes = submissions.map(s => s.runtime);
    const allMemories = submissions.map(s => s.memory);
    
    // 计算击败率
    newSubmission.beatRuntimePct = calculateBeatPercentage(currentRuntime, allRuntimes, true);
    newSubmission.beatMemoryPct = calculateBeatPercentage(currentMemory, allMemories, true);
    
    if (newSubmission.beatRuntimePct !== null && newSubmission.beatMemoryPct !== null) {
        console.log(`[Server] 性能排名 - 运行时间击败了 ${newSubmission.beatRuntimePct}% 的用户, 内存击败了 ${newSubmission.beatMemoryPct}% 的用户`);
    }

    res.json({ 
        message: '提交成功，云端已接收',
        beatRuntimePct: newSubmission.beatRuntimePct,
        beatMemoryPct: newSubmission.beatMemoryPct
    });
});

// 2. 网页端轮询接口：检查有没有新提交
app.get('/api/check', (req, res) => {
    // 返回最新的一条提交记录（如果存在）
    if (submissions.length > 0) {
        const latestSubmission = submissions[submissions.length - 1];
        res.json(latestSubmission);
    } else {
        res.json(null); // 没有新提交
    }
});

// 3. (可选) 网页端处理完后，标记为已读，避免重复弹窗
app.post('/api/mark_read', (req, res) => {
    if (submissions.length > 0) {
        const latestSubmission = submissions[submissions.length - 1];
        latestSubmission.status = 'read'; // 标记已读
    }
    res.json({ status: 'ok' });
});

// 4. 获取提交历史统计和分布数据
app.get('/api/stats', (req, res) => {
    const validSubmissions = submissions.filter(s => s.runtime >= 0 && s.memory >= 0);
    
    res.json({
        totalSubmissions: submissions.length,
        validSubmissions: validSubmissions.length,
        runtimeDistribution: validSubmissions.map(s => s.runtime),
        memoryDistribution: validSubmissions.map(s => s.memory / (1024 * 1024)) // 转换为 MB
    });
});

app.listen(PORT, () => {
    console.log(`🚀 后端服务器启动: http://localhost:${PORT}`);
});

