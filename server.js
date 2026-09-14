const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const youtubedl = require('youtube-dl-exec');
const cron = require('node-cron');
const axios = require('axios');
const { exec } = require('child_process');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Lightweight Database
const DB_FILE = path.join(__dirname, 'db.json');

const loadDB = () => {
    if (!fs.existsSync(DB_FILE)) return { sessionId: '', targetChannel: '', uploadedVideos: [] };
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
};

const saveDB = (data) => {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
};

// Global Logs
let memoryLogs = ['System initialized. Waiting for events...'];
const addLog = (msg) => {
    console.log(msg);
    memoryLogs.push(`[${new Date().toLocaleTimeString()}] ${msg}`);
    if (memoryLogs.length > 50) memoryLogs.shift();
};

// --- API Endpoints ---
app.get('/api/config', (req, res) => res.json(loadDB()));
app.get('/api/logs', (req, res) => res.json({ logs: memoryLogs }));

app.post('/api/config', (req, res) => {
    const db = loadDB();
    db.sessionId = req.body.sessionId;
    db.targetChannel = req.body.targetChannel;
    saveDB(db);
    res.json({ success: true });
});

app.post('/api/trigger', async (req, res) => {
    res.json({ success: true, message: "Upload cycle started..." });
    executeAutoUpload(); // run async
});

// --- Core Upload Logic ---
const executeAutoUpload = async () => {
    const db = loadDB();
    if (!db.sessionId || !db.targetChannel) {
        addLog('[-] ERROR: Missing Session ID or Target Channel in configuration.');
        return;
    }

    try {
        addLog(`[+] Scraping latest Short from ${db.targetChannel}`);
        
        // Ensure we search the /shorts tab of the channel
        let channelUrl = db.targetChannel;
        if (!channelUrl.endsWith('/shorts')) channelUrl = channelUrl.replace(/\/$/, '') + '/shorts';

        // Get latest short ID and Title
        const ytInfo = await youtubedl(channelUrl, {
            print: '%(id)s|||%(title)s',
            playlistEnd: 1,
            noWarnings: true
        });

        const rawOutput = ytInfo.trim();
        if (!rawOutput) throw new Error("No shorts found on this channel.");
        
        const [latestVideoId, videoTitle] = rawOutput.split('|||');

        if (db.uploadedVideos.includes(latestVideoId)) {
            addLog(`[!] Video ${latestVideoId} already uploaded. Checking again in 15 mins...`);
            return;
        }

        const youtubeUrl = `https://youtube.com/shorts/${latestVideoId}`;
        addLog(`[+] New Video Found: "${videoTitle}"`);
        
        // Download Video
        addLog(`[+] Downloading video to Cloud Server...`);
        const videoPath = path.join(__dirname, `temp_${Date.now()}.mp4`);
        await youtubedl(youtubeUrl, {
            output: videoPath,
            format: 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio',
            mergeOutputFormat: 'mp4',
            noWarnings: true
        });

        const videoBuffer = fs.readFileSync(videoPath);
        addLog(`[+] Download complete. (${(videoBuffer.length / 1024 / 1024).toFixed(2)} MB)`);

        // Fetch Thumbnail
        addLog(`[+] Fetching thumbnail...`);
        const thumbResponse = await axios.get(`https://img.youtube.com/vi/${latestVideoId}/maxresdefault.jpg`, { responseType: 'arraybuffer' })
            .catch(async () => await axios.get(`https://img.youtube.com/vi/${latestVideoId}/hqdefault.jpg`, { responseType: 'arraybuffer' }));
        const coverBuffer = Buffer.from(thumbResponse.data);
        const thumbPath = path.join(__dirname, `thumb_${Date.now()}.jpg`);
        fs.writeFileSync(thumbPath, coverBuffer);

        // Upload to Instagram via Python Script
        addLog(`[+] Initiating Upload via Session ID...`);
        
        // Use the original YouTube title as the Instagram caption!
        const caption = videoTitle ? `${videoTitle}\n\n#shorts #viral #reels` : 'Auto uploaded via Insta Auto Uploader 🔥';
        
        exec(`python upload.py "${db.sessionId}" "${videoPath}" "${thumbPath}" "${caption}"`, (error, stdout, stderr) => {
            if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
            if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);

            if (error) {
                addLog(`[-] PYTHON ERROR: ${error.message}`);
                return;
            }
            
            try {
                const result = JSON.parse(stdout);
                if (result.success) {
                    addLog(`[🎉] SUCCESS! Reel Published! Code: ${result.media_code}`);
                    // Save to DB to prevent duplicate uploads
                    db.uploadedVideos.push(latestVideoId);
                    saveDB(db);
                } else {
                    addLog(`[-] UPLOAD FAILED: ${result.error}`);
                }
            } catch (parseError) {
                addLog(`[-] PARSE ERROR: ${stdout}`);
            }
        });

    } catch (error) {
        addLog(`[-] ERROR: ${error.message}`);
    }
};

// --- Cron Job ---
// Checks for new videos every 15 minutes!
cron.schedule('*/15 * * * *', () => {
    executeAutoUpload();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    addLog(`🚀 Cloud Bot is running on port ${PORT}`);
});
