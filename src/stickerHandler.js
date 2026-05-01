const sharp = require("sharp");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
const { writeFile, unlink } = require("fs/promises");
const { tmpdir } = require("os");
const path = require("path");

if (ffmpegPath) {
  ffmpeg.setFfmpegPath(ffmpegPath);
}

/**
 * Convert buffer gambar ke WebP untuk sticker WhatsApp
 */
async function convertImageToSticker(imageBuffer) {
  return sharp(imageBuffer)
    .resize(512, 512, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .webp({ quality: 80 })
    .toBuffer();
}

/**
 * Convert buffer video ke animated WebP untuk sticker WhatsApp
 * Limit: max 3 detik, 512x512, loop sekali
 */
async function convertVideoToSticker(videoBuffer, mimeType = "video/mp4") {
  if (!ffmpegPath) {
    throw new Error("ffmpeg binary not found");
  }

  const ext = mimeType.includes("webm") ? "webm" : mimeType.includes("gif") ? "gif" : "mp4";
  const inputPath = path.join(tmpdir(), `sticker_in_${Date.now()}.${ext}`);
  const outputPath = path.join(tmpdir(), `sticker_out_${Date.now()}.webp`);

  try {
    // Tulis buffer ke file temp
    await writeFile(inputPath, videoBuffer);

    // Convert ke animated WebP via ffmpeg
    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .outputOptions([
          "-vcodec",
          "libwebp",
          "-vf",
          "scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000,fps=15",
          "-loop",
          "0", // loop infinite
          "-preset",
          "default",
          "-an", // no audio
          "-vsync",
          "0",
          "-t",
          "10", // max 10 detik
          "-quality",
          "80",
        ])
        .toFormat("webp")
        .save(outputPath)
        .on("end", resolve)
        .on("error", reject);
    });

    // Baca hasil output
    const { readFile } = require("fs/promises");
    const stickerBuffer = await readFile(outputPath);
    return stickerBuffer;
  } finally {
    // Cleanup file temp
    await unlink(inputPath).catch(() => {});
    await unlink(outputPath).catch(() => {});
  }
}

/**
 * Ambil buffer media dari pesan WhatsApp
 * Support: imageMessage, videoMessage, stickerMessage
 */
async function getMediaBuffer(sock, msg) {
  const { downloadMediaMessage } = require("@whiskeysockets/baileys");
  try {
    const buffer = await downloadMediaMessage(msg, "buffer", {});
    return buffer;
  } catch (err) {
    console.error("❌ Gagal download media:", err.message);
    return null;
  }
}

/**
 * Deteksi tipe media dari pesan
 */
function getMediaType(msg) {
  if (msg.message?.imageMessage) return "image";
  if (msg.message?.videoMessage) return "video";
  if (msg.message?.documentMessage) {
    const mime = msg.message.documentMessage.mimetype || "";
    if (mime.startsWith("video/") || mime.startsWith("image/")) return "document";
  }
  return null;
}

function getMimeType(msg) {
  return msg.message?.imageMessage?.mimetype || msg.message?.videoMessage?.mimetype || msg.message?.documentMessage?.mimetype || "video/mp4";
}

module.exports = {
  convertImageToSticker,
  convertVideoToSticker,
  getMediaBuffer,
  getMediaType,
  getMimeType,
};
