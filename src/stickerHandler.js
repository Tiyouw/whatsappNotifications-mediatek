const sharp = require('sharp')

/**
 * Convert buffer gambar ke format WebP untuk sticker WhatsApp
 * @param {Buffer} imageBuffer
 * @returns {Buffer} WebP buffer
 */
async function convertToSticker(imageBuffer) {
  return sharp(imageBuffer)
    .resize(512, 512, {
      fit: 'contain',       // jaga aspect ratio, tidak crop
      background: { r: 0, g: 0, b: 0, alpha: 0 } // background transparan
    })
    .webp({ quality: 80 })
    .toBuffer()
}

/**
 * Ambil buffer media dari pesan WhatsApp
 * Support: imageMessage, stickerMessage
 */
async function getMediaBuffer(sock, msg) {
  const message = msg?.message
  const mediaMsg = message?.imageMessage || message?.stickerMessage
  if (!mediaMsg) return null

  try {
    const { downloadMediaMessage } = require('@whiskeysockets/baileys')
    const buffer = await downloadMediaMessage(msg, 'buffer', {})
    return buffer
  } catch (err) {
    console.error('❌ Gagal download gambar:', err.message)
    return null
  }
}

// Backward compatible alias
async function getImageBuffer(sock, msg) {
  return getMediaBuffer(sock, msg)
}

module.exports = { convertToSticker, getMediaBuffer, getImageBuffer }
