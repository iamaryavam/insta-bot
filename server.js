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
    if (!fs.existsSync(DB_FILE)) return { sessionId: '', targetChannel: '', ytCookies: '', uploadedVideos: [] };
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
    db.ytCookies = req.body.ytCookies || '';
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
    if (!db.sessionId || !db.targetChannel || !db.ytCookies) {
        addLog('[-] ERROR: Missing Session ID, Target Channel, or YouTube Cookies in configuration.');
        return;
    }

    const cookiesPath = path.join(__dirname, `cookies_${Date.now()}.txt`);
    try {
        // Write cookies to a temporary file
        fs.writeFileSync(cookiesPath, db.ytCookies);

        addLog(`[+] Scraping latest Short from ${db.targetChannel}`);
        
        // Ensure it targets the /shorts tab even if query parameters exist
        let channelUrl = db.targetChannel;
        try {
            const urlObj = new URL(channelUrl);
            if (!urlObj.pathname.endsWith('/shorts')) {
                urlObj.pathname = urlObj.pathname.replace(/\/$/, '') + '/shorts';
            }
            channelUrl = urlObj.toString();
        } catch (e) {
            if (!channelUrl.endsWith('/shorts')) channelUrl = channelUrl.replace(/\/$/, '') + '/shorts';
        }

        // Get latest short ID and Title (use flat-playlist to avoid bot block on individual video)
        const ytInfo = await youtubedl(channelUrl, {
            print: '%(id)s|||%(title)s',
            playlistEnd: 1,
            flatPlaylist: true,
            noWarnings: true,
            cookies: cookiesPath,
            jsRuntimes: 'node'
        });

        const rawOutput = ytInfo.trim();
        if (!rawOutput) throw new Error("No shorts found on this channel.");
        
        const [latestVideoId, videoTitle] = rawOutput.split('|||');

        if (db.uploadedVideos.includes(latestVideoId)) {
            addLog(`[!] Video ${latestVideoId} already uploaded. Checking again in 15 mins...`);
            if (fs.existsSync(cookiesPath)) fs.unlinkSync(cookiesPath);
            return;
        }

        const youtubeUrl = `https://youtube.com/shorts/${latestVideoId}`;
        addLog(`[+] New Video Found: "${videoTitle}"`);
        
        // Download Video via Loader.to API
        addLog(`[+] Requesting video generation from Loader.to API...`);
        let videoPath = path.join(__dirname, `temp_${Date.now()}.mp4`);
        
        const initRes = await fetch(`https://loader.to/ajax/download.php?format=720&url=${encodeURIComponent(youtubeUrl)}`);
        const initData = await initRes.json();
        if (!initData.id) throw new Error("Loader.to API failed to initiate task.");
        
        const taskId = initData.id;
        let downloadUrl = null;
        
        // Polling loop
        for (let i = 0; i < 60; i++) { // Max 2 mins wait (60 * 2000ms)
            await new Promise(resolve => setTimeout(resolve, 2000));
            const progressRes = await fetch(`https://loader.to/ajax/progress.php?id=${taskId}`);
            const progressData = await progressRes.json();
            
            if (progressData.success === 1 && progressData.download_url) {
                downloadUrl = progressData.download_url;
                break;
            }
            addLog(`[~] Loader.to processing: ${progressData.progress || 0}/1000...`);
        }
        
        if (!downloadUrl) throw new Error("Loader.to API timed out.");
        
        addLog(`[+] Downloading processed video to Cloud Server...`);
        const response = await fetch(downloadUrl);
        const buffer = await response.arrayBuffer();
        fs.writeFileSync(videoPath, Buffer.from(buffer));

        const videoBuffer = fs.readFileSync(videoPath);
        addLog(`[+] Download complete. (${(videoBuffer.length / 1024 / 1024).toFixed(2)} MB)`);

        // Convert VP9/WebM to H.264 (Instagram requirement) with High Quality
        addLog(`[+] Optimizing video format for Instagram (High Quality)...`);
        const optimizedPath = path.join(__dirname, `opt_${Date.now()}.mp4`);
        await new Promise((resolve, reject) => {
            exec(`ffmpeg -y -i "${videoPath}" -c:v libx264 -preset fast -crf 18 -c:a aac -b:a 128k -movflags +faststart "${optimizedPath}"`, (err, stdout, stderr) => {
                if (err) {
                    addLog(`[-] FFmpeg Error: ${err.message}`);
                    resolve();
                } else {
                    if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
                    resolve(optimizedPath);
                }
            });
        }).then(resPath => {
            if (resPath) videoPath = resPath;
        });

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
            if (fs.existsSync(cookiesPath)) fs.unlinkSync(cookiesPath);

            if (error) {
                addLog(`[-] UPLOAD FAILED: ${error.message}`);
                return;
            }
            
            // Check if stdout contains success to bypass Instagrapi warnings
            if (stdout.includes('"success": true') || stdout.includes('"success":true')) {
                addLog(`[🎉] SUCCESS! Reel Published!`);
                // Mark as uploaded to prevent duplicates
                if (!db.uploadedVideos.includes(latestVideoId)) {
                    db.uploadedVideos.push(latestVideoId);
                    saveDB(db);
                }
            } else {
                addLog(`[-] PARSE ERROR or Upload Failed: ${stdout}`);
            }
        });

    } catch (error) {
        addLog(`[-] ERROR: ${error.message}`);
        if (fs.existsSync(cookiesPath)) fs.unlinkSync(cookiesPath);
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
