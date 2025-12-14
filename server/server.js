const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3000;

// 允许跨域（这很重要，否则网页和插件都连不上）
app.use(cors());
app.use(bodyParser.json());

// --- 核心逻辑：内存数据库 ---
// 存储所有提交记录的数组，用于计算性能排名
// 演示结束后重启服务器就会清空，非常适合大作业
let submissions = [];

// --- 问题数据库（包含测试用例）---
// 每个问题包含 id, title, description, testCases, difficulty
// testCases 格式: [{ input: "1 2", expected: "3" }, ...]
// 定义数据文件路径
const PROBLEMS_FILE = path.join(__dirname, 'problems.json');

// 默认初始题目
const DEFAULT_PROBLEMS = [
    {
        id: "101",
        title: "A + B Problem",
        description: "计算两个整数的和",
        difficulty: "简单",
        testCases: [
            { input: "1 2", expected: "3" },
            { input: "10 20", expected: "30" },
            { input: "-5 5", expected: "0" },
            { input: "1000000 2000000", expected: "3000000" }
        ]
    },
    {
        id: "102",
        title: "两数之和",
        description: "给定一个整数数组和一个目标值，找出数组中和为目标值的两个数的索引",
        difficulty: "简单",
        testCases: [
            { input: "2 7 11 15\n9", expected: "0 1" },
            { input: "3 2 4\n6", expected: "1 2" },
            { input: "3 3\n6", expected: "0 1" }
        ]
    },
    {
        id: "103",
        title: "最大子数组和",
        description: "找到一个具有最大和的连续子数组",
        difficulty: "中等",
        testCases: [
            { input: "-2 1 -3 4 -1 2 1 -5 4", expected: "6" },
            { input: "1", expected: "1" },
            { input: "5 4 -1 7 8", expected: "23" }
        ]
    }
];

// 初始化问题数据库：从文件读取，如果不存在则创建默认文件
let problemsDatabase = [];

function initializeProblemsDatabase() {
    try {
        // 检查文件是否存在
        if (fs.existsSync(PROBLEMS_FILE)) {
            // 读取文件内容
            const fileContent = fs.readFileSync(PROBLEMS_FILE, 'utf8');
            problemsDatabase = JSON.parse(fileContent);
            console.log(`[Server] 从文件加载了 ${problemsDatabase.length} 道题目`);
        } else {
            // 文件不存在，使用默认题目并写入文件
            problemsDatabase = JSON.parse(JSON.stringify(DEFAULT_PROBLEMS));
            fs.writeFileSync(PROBLEMS_FILE, JSON.stringify(problemsDatabase, null, 2), 'utf8');
            console.log(`[Server] 创建了默认题目文件，包含 ${problemsDatabase.length} 道题目`);
        }
    } catch (error) {
        console.error('[Server] 初始化题目数据库失败:', error);
        // 出错时使用默认题目
        problemsDatabase = JSON.parse(JSON.stringify(DEFAULT_PROBLEMS));
    }
}

// 保存题目到文件
function saveProblemsToFile() {
    try {
        fs.writeFileSync(PROBLEMS_FILE, JSON.stringify(problemsDatabase, null, 2), 'utf8');
        console.log(`[Server] 题目已保存到文件，当前共 ${problemsDatabase.length} 道题目`);
    } catch (error) {
        console.error('[Server] 保存题目到文件失败:', error);
        throw error;
    }
}

// 启动时初始化
initializeProblemsDatabase();

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
    const { code, problemId, output, runtime, memory, timestamp, status, failedCase, errorMessage } = req.body;
    console.log(`[Server] 收到来自 VS Code 的提交: 题目ID=${problemId}, 状态=${status || 'pending'}`);
    
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
        status: status || 'pending', // ✨ 支持从 extension 传来的状态（Accepted/Wrong Answer等）
        failedCase: failedCase, // ✨ 失败的测试用例编号
        errorMessage: errorMessage, // ✨ 错误信息
        submissionStatus: 'pending' // 待网页端处理（保留旧字段以兼容）
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
    const problemId = req.query.problemId; // ✨ 支持按问题ID筛选
    let filteredSubmissions = submissions;
    
    // 如果指定了 problemId，只返回该问题的提交
    if (problemId) {
        filteredSubmissions = submissions.filter(s => s.problemId === problemId);
    }
    
    const validSubmissions = filteredSubmissions.filter(s => s.runtime >= 0 && s.memory >= 0);
    
    // ✨ 按时间排序，用于折线图
    const sortedSubmissions = validSubmissions.sort((a, b) => a.timestamp - b.timestamp);
    
    res.json({
        totalSubmissions: filteredSubmissions.length,
        validSubmissions: validSubmissions.length,
        runtimeDistribution: validSubmissions.map(s => s.runtime), // 保留用于兼容
        memoryDistribution: validSubmissions.map(s => s.memory / (1024 * 1024)), // 保留用于兼容
        // ✨ 新增：时间序列数据（用于折线图）
        history: sortedSubmissions.map(s => ({
            timestamp: s.timestamp,
            runtime: s.runtime,
            memory: s.memory / (1024 * 1024), // 转换为 MB
            status: s.status || 'Accepted'
        }))
    });
});

// 5. ✨ 获取问题的测试用例
app.get('/api/problem/:problemId', (req, res) => {
    const problemId = req.params.problemId;
    const problem = problemsDatabase.find(p => p.id === problemId);
    
    if (problem) {
        res.json(problem);
    } else {
        res.status(404).json({ error: 'Problem not found' });
    }
});

// 6. ✨ 获取所有问题列表（返回完整信息，包含标题和难度）
app.get('/api/problems', (req, res) => {
    res.json(problemsDatabase.map(p => ({ 
        id: p.id, 
        title: p.title, 
        description: p.description,
        difficulty: p.difficulty || '中等'
    })));
});

// 7. ✨ 新增题目接口
app.post('/api/problems', (req, res) => {
    const { id, title, description, testCases, difficulty } = req.body;
    
    // 验证必要字段
    if (!id || !title || !description || !testCases || !Array.isArray(testCases) || testCases.length === 0) {
        return res.status(400).json({ 
            error: '题目数据不完整：必须包含 id, title, description 和 testCases（至少一个测试用例）' 
        });
    }
    
    // 检查是否已存在相同 ID 的题目
    const existingIndex = problemsDatabase.findIndex(p => p.id === id);
    
    if (existingIndex >= 0) {
        // 更新已存在的题目
        problemsDatabase[existingIndex] = {
            id,
            title,
            description,
            testCases,
            difficulty: difficulty || '中等'
        };
        console.log(`[Server] 更新题目: ${id} - ${title}`);
    } else {
        // 添加新题目
        problemsDatabase.push({
            id,
            title,
            description,
            testCases,
            difficulty: difficulty || '中等'
        });
        console.log(`[Server] 新增题目: ${id} - ${title}`);
    }
    
    // 同步写入文件
    try {
        saveProblemsToFile();
        res.json({ 
            message: '题目保存成功',
            problem: {
                id,
                title,
                description,
                difficulty: difficulty || '中等',
                testCasesCount: testCases.length
            }
        });
    } catch (error) {
        console.error('[Server] 保存题目失败:', error);
        res.status(500).json({ error: '保存题目到文件失败' });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 后端服务器启动: http://localhost:${PORT}`);
});

