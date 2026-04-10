import express from "express";
import { createServer as createViteServer } from "vite";
import multer from "multer";
import path from "path";
import fs from "fs";
import cors from "cors";
import { GoogleGenAI } from "@google/genai";

// Check and clean up invalid CLOUDINARY_URL before any cloudinary import
if (process.env.CLOUDINARY_URL && !process.env.CLOUDINARY_URL.startsWith("cloudinary://")) {
  console.warn("Invalid CLOUDINARY_URL detected. It must start with 'cloudinary://'. Cloudinary uploads will be disabled.");
  delete process.env.CLOUDINARY_URL;
}

const app = express();
const PORT = 3000;

app.set('trust proxy', true); // Trust proxy to get real IP

app.use(cors());
app.use(express.json());

const mutedIPs = new Map<string, number>();

// Set up upload directory for temporary storage
const uploadDir = path.join(process.cwd(), "uploads");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + "-" + file.originalname);
  },
});

const upload = multer({ 
  storage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB limit
  fileFilter: (req, file, cb) => {
    const dangerousExts = ['.exe', '.bat', '.cmd', '.sh', '.msi', '.vbs', '.js', '.scr', '.jar'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (dangerousExts.includes(ext)) {
      return cb(new Error('Загрузка исполняемых файлов и вирусов запрещена.'));
    }
    cb(null, true);
  }
});

// In-memory database for files is removed. We use Firestore now.

// Initialize Gemini API
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

// Helper to convert local file to base64 for Gemini
function fileToBase64(filePath: string): string {
  const fileData = fs.readFileSync(filePath);
  return fileData.toString("base64");
}

// API Routes
app.post("/api/upload", (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || "unknown";

  if (mutedIPs.has(ip)) {
    const expiration = mutedIPs.get(ip)!;
    if (Date.now() < expiration) {
      const timeLeft = Math.ceil((expiration - Date.now()) / 1000);
      return res.status(403).json({ error: `Вы замучены за нарушение правил. Подождите ${timeLeft} сек.` });
    } else {
      mutedIPs.delete(ip);
    }
  }

  upload.single("file")(req, res, async (err) => {
    if (err) {
      if (err.message.includes('запрещена')) {
        mutedIPs.set(ip, Date.now() + 60 * 1000);
        return res.status(400).json({ error: err.message + " Вы получили мут на 1 минуту." });
      }
      return res.status(400).json({ error: err.message });
    }
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const localPath = req.file.path;
    const isMedia = req.file.mimetype.startsWith("image/") || req.file.mimetype.startsWith("video/");

    // 1. AI Moderation FIRST (before Cloudinary and before adding to feed)
    if (isMedia) {
      if (req.file.size > 15 * 1024 * 1024) {
        fs.unlink(localPath, () => {});
        return res.status(400).json({ error: "Медиафайл слишком большой для ИИ-модерации (>15MB). Загрузка отменена." });
      }

      try {
        const safety = await checkMediaSafety(localPath, req.file.mimetype);
        if (!safety.isSafe) {
          fs.unlink(localPath, () => {}); // Delete forbidden file
          mutedIPs.set(ip, Date.now() + 60 * 1000); // Mute user
          return res.status(403).json({ error: `Файл заблокирован ИИ: ${safety.reason}. Вы получили мут на 1 минуту.` });
        }
      } catch (error) {
        console.error("Moderation error:", error);
        fs.unlink(localPath, () => {});
        return res.status(500).json({ error: "Ошибка проверки файла нейросетью. Попробуйте позже." });
      }
    }

    // 2. Upload to Cloudinary if safe
    let fileUrl = `/uploads/${req.file.filename}`;
    let isCloudinary = false;

    if (process.env.CLOUDINARY_URL) {
      try {
        const cloudinary = (await import("cloudinary")).v2;
        const result = await cloudinary.uploader.upload(localPath, {
          resource_type: "auto",
          folder: "tarox_uploads"
        });
        fileUrl = result.secure_url;
        isCloudinary = true;
        fs.unlink(localPath, () => {}); // Clean up local file after Cloudinary upload
      } catch (error) {
        console.error("Cloudinary upload failed, falling back to local storage:", error);
      }
    }

    // 3. Return file metadata to client
    res.json({
      filename: req.file.filename,
      originalName: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size,
      url: fileUrl,
      uploadedAt: new Date().toISOString(),
      moderationStatus: "approved",
    });
  });
});

async function checkMediaSafety(filePath: string, mimetype: string): Promise<{isSafe: boolean, reason: string}> {
  const base64Data = fileToBase64(filePath);
  const response = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: {
      parts: [
        {
          inlineData: {
            mimeType: mimetype,
            data: base64Data,
          },
        },
        {
          text: "Analyze this media for moderation. Is it safe for work (no explicit content, violence, or illegal acts)? Reply with a JSON object containing two fields: 'isSafe' (boolean) and 'reason' (string explaining why).",
        },
      ],
    },
    config: {
      responseMimeType: "application/json",
    },
  });

  const resultText = response.text || "{}";
  const result = JSON.parse(resultText);
  return { isSafe: !!result.isSafe, reason: result.reason || "Без причины" };
}

// Serve uploaded files
app.use("/uploads", express.static(uploadDir));

// Google Drive Mock Endpoint
app.post("/api/gdrive/link", (req, res) => {
  // In a real app, this would initiate the OAuth flow
  res.json({ success: true, message: "Google Drive linked successfully (Mock)" });
});

async function startServer() {
  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
