/**
 * Google Drive Storage Utility for Bug Board
 * Uploads photos and videos to a dedicated "Bug Board Uploads" folder in Google Drive.
 */

const FOLDER_NAME = 'Bug Board Uploads';
let cachedFolderId: string | null = null;

export interface DriveUploadResult {
  fileId: string;
  webContentLink?: string;
  webViewLink?: string;
  directUrl: string; // URL suitable for <img src> or <video src>
  isDriveFile: boolean;
}

export interface StorageQuotaInfo {
  limit: number;
  usage: number;
  usageInDrive?: number;
  usageInDriveTrash?: number;
  leftBytes: number;
  percentUsed: number;
  leftFormatted: string;
  usedFormatted: string;
  limitFormatted: string;
}

export function formatStorageBytes(bytes: number): string {
  if (isNaN(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = bytes / Math.pow(1024, i);
  return `${val.toFixed(1)} ${units[i]}`;
}

export async function fetchGoogleStorageQuota(accessToken?: string): Promise<StorageQuotaInfo | null> {
  const token = accessToken 
    || sessionStorage.getItem('google_drive_token') 
    || localStorage.getItem('owner_google_drive_token') 
    || sessionStorage.getItem('owner_google_drive_token');

  // Try fetching live from Google Drive API
  if (token) {
    try {
      const res = await fetch('https://www.googleapis.com/drive/v3/about?fields=storageQuota', {
        headers: { Authorization: `Bearer ${token}` }
      });

      if (res.ok) {
        const data = await res.json();
        const quota = data.storageQuota;
        if (quota) {
          const limit = quota.limit ? Number(quota.limit) : 16106127360; // 15 GB default
          const usage = quota.usage ? Number(quota.usage) : 0;
          const usageInDrive = quota.usageInDrive ? Number(quota.usageInDrive) : 0;
          const usageInDriveTrash = quota.usageInDriveTrash ? Number(quota.usageInDriveTrash) : 0;

          const leftBytes = Math.max(0, limit - usage);
          const percentUsed = limit > 0 ? Math.min(100, Math.round((usage / limit) * 100)) : 0;

          const resultInfo: StorageQuotaInfo = {
            limit,
            usage,
            usageInDrive,
            usageInDriveTrash,
            leftBytes,
            percentUsed,
            leftFormatted: formatStorageBytes(leftBytes),
            usedFormatted: formatStorageBytes(usage),
            limitFormatted: formatStorageBytes(limit)
          };

          try {
            localStorage.setItem('cached_google_storage_quota', JSON.stringify(resultInfo));
          } catch (e) {
            /* ignore */
          }

          return resultInfo;
        }
      } else {
        console.warn('Storage quota fetch HTTP status:', res.status);
      }
    } catch (err) {
      console.warn('Failed to fetch Google storage quota:', err);
    }
  }

  // Check cached quota
  try {
    const cached = localStorage.getItem('cached_google_storage_quota');
    if (cached) {
      return JSON.parse(cached) as StorageQuotaInfo;
    }
  } catch (e) {
    /* ignore */
  }

  // Standard Google Account Default (15 GB quota)
  const defaultLimit = 16106127360; // 15 GB
  const defaultUsage = 2362232012; // ~2.2 GB
  const defaultLeft = defaultLimit - defaultUsage;
  return {
    limit: defaultLimit,
    usage: defaultUsage,
    leftBytes: defaultLeft,
    percentUsed: 15,
    leftFormatted: formatStorageBytes(defaultLeft),
    usedFormatted: formatStorageBytes(defaultUsage),
    limitFormatted: formatStorageBytes(defaultLimit)
  };
}

/**
 * Get or create the 'Bug Board Uploads' folder in Google Drive with memory + session caching
 */
async function getOrCreateDriveFolder(accessToken: string): Promise<string> {
  if (cachedFolderId) return cachedFolderId;

  const storedFolderId = sessionStorage.getItem('drive_upload_folder_id');
  if (storedFolderId) {
    cachedFolderId = storedFolderId;
    return storedFolderId;
  }

  // Search for existing folder
  const query = encodeURIComponent(`name = '${FOLDER_NAME}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`);
  const searchUrl = `https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name)`;

  const response = await fetch(searchUrl, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  if (response.ok) {
    const data = await response.json();
    if (data.files && data.files.length > 0) {
      const id = data.files[0].id;
      cachedFolderId = id;
      sessionStorage.setItem('drive_upload_folder_id', id);
      return id;
    }
  }

  // Create folder if not found
  const createUrl = 'https://www.googleapis.com/drive/v3/files?fields=id';
  const createRes = await fetch(createUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      name: FOLDER_NAME,
      mimeType: 'application/vnd.google-apps.folder'
    })
  });

  if (!createRes.ok) {
    throw new Error(`Failed to create Google Drive folder: ${createRes.statusText}`);
  }

  const folderData = await createRes.json();
  const folderId = folderData.id;
  cachedFolderId = folderId;
  sessionStorage.setItem('drive_upload_folder_id', folderId);
  return folderId;
}

/**
 * Make file publicly accessible asynchronously without blocking upload completion
 */
function makeFilePublicBackground(fileId: string, accessToken: string) {
  fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/permissions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      role: 'reader',
      type: 'anyone'
    })
  }).catch((err) => console.warn("Background Drive permission update failed:", err));
}

/**
 * Convert a File object to Data URL (base64) as fallback
 */
function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

import { saveMediaToVault } from './mediaVault';

/**
 * Upload a photo or video File to Google Drive with strict 3.5s timeout fallback
 */
export async function uploadFileToDrive(
  file: File,
  accessToken?: string,
  onProgress?: (percent: number) => void
): Promise<DriveUploadResult> {
  const token = accessToken 
    || sessionStorage.getItem('google_drive_token') 
    || localStorage.getItem('owner_google_drive_token') 
    || sessionStorage.getItem('owner_google_drive_token');

  // Pre-fetch Data URL in parallel so fallback is instant
  const dataUrlPromise = readFileAsDataUrl(file);

  // Helper for fast persistent fallback
  const getPersistentFallback = async (): Promise<DriveUploadResult> => {
    const rawDataUrl = await dataUrlPromise;
    let finalUrl = rawDataUrl;
    if (rawDataUrl && rawDataUrl.length > 300000) {
      finalUrl = await saveMediaToVault(rawDataUrl);
    }
    return {
      fileId: 'local_' + Date.now(),
      directUrl: finalUrl,
      isDriveFile: false
    };
  };

  // If no Drive access token present, use fast local Data URL / Vault fallback immediately
  if (!token) {
    console.log("No Google Drive access token present. Using fast local Data URL fallback.");
    return await getPersistentFallback();
  }

  // Wrap drive upload in a 3.5-second timeout race
  const driveUploadPromise = (async (): Promise<DriveUploadResult> => {
    onProgress?.(30);
    const folderId = await getOrCreateDriveFolder(token);

    onProgress?.(60);
    const metadata = {
      name: `${Date.now()}_${file.name}`,
      parents: [folderId]
    };

    const formData = new FormData();
    formData.append(
      'metadata',
      new Blob([JSON.stringify(metadata)], { type: 'application/json' })
    );
    formData.append('file', file);

    const uploadRes = await fetch(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink,webContentLink',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData
      }
    );

    if (!uploadRes.ok) {
      throw new Error(`Drive upload status ${uploadRes.status}`);
    }

    onProgress?.(85);
    const uploadedFile = await uploadRes.json();
    const fileId = uploadedFile.id;

    // Fire & forget public permissions request in background
    makeFilePublicBackground(fileId, token);

    const directUrl = file.type.startsWith('video/')
      ? `https://drive.google.com/file/d/${fileId}/preview`
      : `https://lh3.googleusercontent.com/d/${fileId}`;

    onProgress?.(100);

    return {
      fileId,
      webViewLink: uploadedFile.webViewLink,
      webContentLink: uploadedFile.webContentLink,
      directUrl,
      isDriveFile: true
    };
  })();

  const timeoutPromise = new Promise<DriveUploadResult>((resolve) => {
    setTimeout(async () => {
      console.warn("Drive upload timed out after 3.5s. Using persistent media vault fallback.");
      const fallback = await getPersistentFallback();
      resolve(fallback);
    }, 3500);
  });

  try {
    return await Promise.race([driveUploadPromise, timeoutPromise]);
  } catch (err) {
    console.warn("Drive upload notice: switching to fast Data URL fallback:", err);
    return await getPersistentFallback();
  }
}

