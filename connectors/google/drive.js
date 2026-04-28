// ============================================================================
// connectors/google/drive.js — Google Drive (via Google OAuth) adapter
// ============================================================================
// Pulls every starred file in the user's Drive into the vault. We use the
// least-privileged scope possible — drive.metadata.readonly — which gives
// us file titles, links, mime types, and modification times but NOT file
// content. That's enough for the vault to surface them as bookmarks; if
// users want to read the contents we open the Drive viewer in a new tab.
//
// Why metadata-only? `drive.readonly` is a *restricted* scope (CASA security
// review required for production access). `drive.metadata.readonly` is
// merely *sensitive* — significantly easier to verify.
// ============================================================================

import { createGoogleAdapter, gFetch, saveGoogleNote } from './_shared.js';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const SCOPES = ['https://www.googleapis.com/auth/drive.metadata.readonly'];

const PAGE_SIZE = 100;
const MAX_PAGES_PER_SYNC = 5;

async function syncDriveStarred({ connection, supabaseAdmin, accessToken }) {
  const cursorIso = connection.metadata?.starred_cursor || null;
  const cursorTime = cursorIso ? new Date(cursorIso).getTime() : 0;

  let saved = 0;
  let skipped = 0;
  let pageToken = null;
  let newest = cursorTime;

  pages: for (let page = 0; page < MAX_PAGES_PER_SYNC; page++) {
    const params = new URLSearchParams({
      q: "starred = true and trashed = false",
      pageSize: String(PAGE_SIZE),
      orderBy: 'modifiedTime desc',
      fields:
        'nextPageToken,files(id,name,mimeType,webViewLink,iconLink,thumbnailLink,modifiedTime,owners(displayName,emailAddress))',
      ...(pageToken ? { pageToken } : {}),
    });
    const data = await gFetch(
      `${DRIVE_API}/files?${params}`,
      accessToken,
      {},
      `gdrive-starred-p${page}`,
    );
    const items = data.files || [];
    if (!items.length) break;

    for (const f of items) {
      const modified = new Date(f.modifiedTime || 0).getTime();
      if (cursorTime && modified <= cursorTime) break pages;

      const result = await saveDriveFile({
        supabaseAdmin,
        userId: connection.user_id,
        file: f,
      });
      if (result === 'saved') saved++;
      else skipped++;

      if (modified > newest) newest = modified;
    }

    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }

  if (newest && newest !== cursorTime) {
    await supabaseAdmin
      .from('social_connections')
      .update({
        metadata: {
          ...(connection.metadata || {}),
          starred_cursor: new Date(newest).toISOString(),
        },
      })
      .eq('id', connection.id);
  }

  return { saved, skipped };
}

async function saveDriveFile({ supabaseAdmin, userId, file }) {
  const url = file.webViewLink;
  if (!url) return 'skipped';

  const title = (file.name || 'Drive file').slice(0, 280);
  const owner = file.owners?.[0]?.displayName || '';
  const description = `Google Drive · ${humanMime(file.mimeType)}${owner ? ` · shared by ${owner}` : ''}`;
  const image = file.thumbnailLink || '';

  const attachment = {
    type: 'bookmark',
    url,
    name: title,
    title,
    description,
    image,
    favicon: file.iconLink || 'https://drive-thirdparty.googleusercontent.com/16/type/application/vnd.google-apps.folder',
    siteName: 'Google Drive',
    articleText: description,
    oembedType: 'gdrive',
    oembedHtml: '',
    authorName: owner,
    authorHandle: file.owners?.[0]?.emailAddress || '',
  };

  return saveGoogleNote({
    supabaseAdmin,
    userId,
    url,
    title,
    attachment,
    tags: ['google-drive', 'starred', driveTagFor(file.mimeType), 'link', 'uploaded'].filter(Boolean),
    source: 'gdrive_starred',
    createdAt: file.modifiedTime ? new Date(file.modifiedTime).toISOString() : undefined,
  });
}

function humanMime(mime) {
  if (!mime) return 'File';
  const map = {
    'application/vnd.google-apps.document': 'Doc',
    'application/vnd.google-apps.spreadsheet': 'Sheet',
    'application/vnd.google-apps.presentation': 'Slides',
    'application/vnd.google-apps.folder': 'Folder',
    'application/pdf': 'PDF',
    'image/png': 'Image',
    'image/jpeg': 'Image',
  };
  return map[mime] || mime.split('/').pop() || 'File';
}

function driveTagFor(mime) {
  if (!mime) return 'file';
  if (mime.includes('document')) return 'doc';
  if (mime.includes('spreadsheet')) return 'sheet';
  if (mime.includes('presentation')) return 'slides';
  if (mime.includes('folder')) return 'folder';
  if (mime.includes('image/')) return 'image';
  if (mime.includes('pdf')) return 'pdf';
  return 'file';
}

export const driveAdapter = createGoogleAdapter({
  id: 'google-drive',
  scopes: SCOPES,
  initialMeta: { starred_cursor: null },
  sync: syncDriveStarred,
});
