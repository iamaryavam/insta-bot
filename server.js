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

let isProcessing = false;

// --- Queue & Scrape Logic ---
const refreshQueues = async () => {
    const db = loadDB();
    if (!db.targetChannel) return;

    addLog(`[+] Scraping Shorts from ${db.targetChannel}...`);
    
    let channelUrl = db.targetChannel;
    try {
        const urlObj = new URL(channelUrl);
        urlObj.search = '';
        if (!urlObj.pathname.endsWith('/shorts')) urlObj.pathname = urlObj.pathname.replace(/\/$/, '') + '/shorts';
        channelUrl = urlObj.toString();
    } catch (e) {
        if (!channelUrl.endsWith('/shorts')) channelUrl = channelUrl.replace(/\/$/, '') + '/shorts';
    }

    const cookiesPath = path.join(__dirname, `cookies_${Date.now()}.txt`);
    try {
        if (db.ytCookies) fs.writeFileSync(cookiesPath, db.ytCookies);

        const ytInfo = await youtubedl(channelUrl, {
            print: '%(id)s|||%(title)s',
            flatPlaylist: true,
            noWarnings: true,
            cookies: db.ytCookies ? cookiesPath : undefined
        });

        const rawOutput = ytInfo.trim();
        if (!rawOutput) return;

        const lines = rawOutput.split('\n').reverse(); // Oldest first
        const newVideos = [];

        lines.forEach(line => {
            const [id, title] = line.split('|||');
            if (id && !db.uploadedVideos.includes(id) && !db.queue.find(q => q.id === id)) {
                newVideos.push({ id, title: title || '' });
            }
        });

        if (newVideos.length > 0) {
            db.queue = [...db.queue, ...newVideos];
            saveDB(db);
            addLog(`[+] Added ${newVideos.length} new Shorts to the Queue.`);
        }
    } catch (e) {
        addLog(`[-] Scrape error: ${e.message}`);
    } finally {
        if (fs.existsSync(cookiesPath)) fs.unlinkSync(cookiesPath);
    }
};

// --- Core Upload Logic ---
const executeAutoUpload = async (force = false) => {
    if (isProcessing) return;
    isProcessing = true;

    let db = loadDB();
    if (!db.sessionId || !db.targetChannel) {
        addLog('[-] ERROR: Missing Session ID or Target Channel.');
        isProcessing = false;
        return;
    }

    // Check if it's time to upload
    if (!force && db.nextUploadTime && Date.now() < db.nextUploadTime) {
        isProcessing = false;
        return; // Not time yet
    }

    try {
        await refreshQueues();
        db = loadDB();

        if (!db.queue || db.queue.length === 0) {
            addLog('[-] Queue is empty. No videos to upload.');
            isProcessing = false;
            return;
        }

        const video = db.queue.pop();
        saveDB(db); // Save immediately so we don't double process if it crashes

        const youtubeUrl = `https://youtube.com/shorts/${video.id}`;
        addLog(`[+] Processing Video: "${video.title}"`);
        
        // Download Video via Loader.to API
        addLog(`[+] Requesting video from Loader.to API...`);
        let videoPath = path.join(__dirname, `temp_${Date.now()}.mp4`);
        
        const initRes = await fetch(`https://loader.to/ajax/download.php?format=1080&url=${encodeURIComponent(youtubeUrl)}`);
        const initData = await initRes.json();
        if (!initData.id) throw new Error("Loader.to API failed to initiate task.");
        
        const taskId = initData.id;
        let downloadUrl = null;
        
        for (let i = 0; i < 60; i++) {
            await new Promise(resolve => setTimeout(resolve, 2000));
            const progressRes = await fetch(`https://loader.to/ajax/progress.php?id=${taskId}`);
            const progressData = await progressRes.json();
            
            if (progressData.success === 1 && progressData.download_url) {
                downloadUrl = progressData.download_url;
                break;
            }
        }
        
        if (!downloadUrl) throw new Error("Loader.to API timed out.");
        
        addLog(`[+] Streaming video directly to disk (Saving RAM)...`);
        const response = await fetch(downloadUrl);
        if (!response.ok) throw new Error('Download failed from Loader.to');
        
        const { Readable } = require('stream');
        const { pipeline } = require('stream/promises');
        await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(videoPath));

        const videoBuffer = fs.readFileSync(videoPath);
        addLog(`[+] Download stream complete. (${(videoBuffer.length / 1024 / 1024).toFixed(2)} MB)`);

        // Convert to H.264
        addLog(`[+] Optimizing video format for Instagram (H.264)...`);
        const optimizedPath = path.join(__dirname, `opt_${Date.now()}.mp4`);
        await new Promise((resolve, reject) => {
            exec(`ffmpeg -y -i "${videoPath}" -c:v libx264 -preset fast -crf 18 -c:a aac -b:a 128k -movflags +faststart "${optimizedPath}"`, (err) => {
                if (err) {
                    addLog(`[-] FFmpeg Error: ${err.message}`);
                    resolve(); // fallback to original
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
        const thumbResponse = await axios.get(`https://img.youtube.com/vi/${video.id}/maxresdefault.jpg`, { responseType: 'arraybuffer' })
            .catch(async () => await axios.get(`https://img.youtube.com/vi/${video.id}/hqdefault.jpg`, { responseType: 'arraybuffer' }));
        const thumbPath = path.join(__dirname, `thumb_${Date.now()}.jpg`);
        fs.writeFileSync(thumbPath, Buffer.from(thumbResponse.data));

        // Upload to Instagram via Python Script
        addLog(`[+] Initiating Upload via Session ID...`);
        const caption = video.title ? `${video.title}\n\n#shorts #viral #reels` : 'Auto uploaded via Insta Auto Uploader 😈';
        
        await new Promise((resolve, reject) => {
            exec(`python upload.py "${db.sessionId}" "${videoPath}" "${thumbPath}" "${caption}"`, (error, stdout, stderr) => {
                if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
                if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);

                if (error) {
                    addLog(`[-] UPLOAD FAILED: ${error.message}`);
                    db.queue.push(video); // Push back to queue if failed
                    saveDB(db);
                    resolve();
                    return;
                }
                
                if (stdout.includes('"success": true') || stdout.includes('"success":true')) {
                    addLog(`[🎉] SUCCESS! Reel Published!`);
                    if (!db.uploadedVideos.includes(video.id)) {
                        db.uploadedVideos.push(video.id);
                    }
                    
                    // Set next upload time based on alternating 30m/60m logic
                    const delayMins = db.nextDelay30 ? 30 : 60;
                    db.nextUploadTime = Date.now() + (delayMins * 60 * 1000);
                    db.nextDelay30 = !db.nextDelay30; // Toggle for next time
                    saveDB(db);
                    
                    addLog(`[+] Next upload scheduled in ${delayMins} minutes.`);
                } else {
                    addLog(`[-] Upload Failed: ${stdout}`);
                    db.queue.push(video); // Push back
                    saveDB(db);
                }
                resolve();
            });
        });

    } catch (error) {
        addLog(`[-] ERROR: ${error.message}`);
    }
    
    isProcessing = false;
};

// --- Cron Job ---
// Check every 5 minutes if it's time to upload
cron.schedule('*/5 * * * *', () => {
    executeAutoUpload(false);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    addLog(`🚀 Cloud Bot is running on port ${PORT}`);
});
