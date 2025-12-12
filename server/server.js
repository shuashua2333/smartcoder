const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
const PORT = 3000;

// 允许跨域（这很重要，否则网页和插件都连不上）
app.use(cors());
app.use(bodyParser.json());

// --- 核心逻辑：内存数据库 ---
// 这是一个全局变量，用来存最后一次提交的代码
// 演示结束后重启服务器就会清空，非常适合大作业
let latestSubmission = null;

// 1. 接收来自 VS Code 的提交
app.post('/api/submit', (req, res) => {
    const { code, problemId, timestamp } = req.body;
    console.log(`[Server] 收到来自 VS Code 的提交: 题目ID=${problemId}`);
    
    // 更新内存状态
    latestSubmission = {
        code,
        problemId,
        timestamp: timestamp || Date.now(),
        status: 'pending' // 待网页端处理
    };

    res.json({ message: '提交成功，云端已接收' });
});

// 2. 网页端轮询接口：检查有没有新提交
app.get('/api/check', (req, res) => {
    // 如果有提交，且状态是 pending，就返回数据
    if (latestSubmission) {
        res.json(latestSubmission);
    } else {
        res.json(null); // 没有新提交
    }
});

// 3. (可选) 网页端处理完后，标记为已读，避免重复弹窗
app.post('/api/mark_read', (req, res) => {
    if (latestSubmission) {
        latestSubmission.status = 'read'; // 标记已读
    }
    res.json({ status: 'ok' });
});

app.listen(PORT, () => {
    console.log(`🚀 后端服务器启动: http://localhost:${PORT}`);
});

