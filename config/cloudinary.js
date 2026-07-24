const cloudinary = require('cloudinary').v2;

// Config Cloudinary (déjà chargé via dotenv)
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ════════════════════════════════
//  HELPER — Upload base64 vers Cloudinary
// ════════════════════════════════
async function uploadToCloudinary(base64String, folder, publicId) {
  const result = await cloudinary.uploader.upload(base64String, {
    folder,
    public_id:      publicId,
    resource_type: 'image',
    overwrite:      true,
  });
  return result.secure_url;
}

module.exports = { cloudinary, uploadToCloudinary };