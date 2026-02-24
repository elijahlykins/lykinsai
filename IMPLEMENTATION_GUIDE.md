# File Storage & AI Workspace Implementation Guide

## Overview
This guide walks through implementing a Google Drive-like file storage system with AI-powered search and organization.

## Step 1: Database Setup

### Run Migration
1. Go to Supabase Dashboard → SQL Editor
2. Copy and paste the contents of `supabase-migrations/001_file_storage_system.sql`
3. Run the migration
4. Verify tables are created: `workspaces`, `folders`, `files`, `file_embeddings`, `chat_queries`

### Verify RLS Policies
Check that Row Level Security is enabled and policies are created for all tables.

## Step 2: Storage Bucket Setup

1. Go to Supabase Dashboard → Storage
2. Create bucket named `user-files` (private)
3. Run the storage policies from `STORAGE_SETUP.md`

## Step 3: Install Dependencies

```bash
npm install react-dropzone
```

## Step 4: Environment Variables

Ensure these are set in your `.env`:
```env
VITE_SUPABASE_URL=your_supabase_url
VITE_SUPABASE_ANON_KEY=your_anon_key
OPENAI_API_KEY=your_openai_key  # For embeddings
```

## Step 5: File Processing Pipeline (Backend)

The file processing happens in the background. You'll need to implement:

### A) Text Extraction
- **PDFs**: Use `pdfjs-dist` (already installed) or `pdf-parse`
- **Images**: OCR with Tesseract.js or cloud OCR service
- **Documents**: Use `mammoth` for Word docs (already installed)
- **Spreadsheets**: Use `xlsx` (already installed)

### B) Embedding Generation
- Use OpenAI `text-embedding-ada-002` model
- Chunk text into ~500-1000 character chunks
- Generate embedding for each chunk
- Store in `file_embeddings` table

### C) Auto-Tagging & Folder Suggestions
- Use AI (GPT-4/Gemini) to analyze extracted text
- Generate tags and suggest folder
- Update file record

## Step 6: Vector Search Implementation

### Query Flow:
1. User asks question in chat
2. Generate embedding for query
3. Use `search_files_by_embedding()` function
4. Retrieve top matching chunks
5. Send context to LLM for answer

### Example:
```sql
SELECT * FROM search_files_by_embedding(
  query_embedding := '[your query embedding]',
  match_threshold := 0.7,
  match_count := 10,
  workspace_uuid := '[user workspace id]'
);
```

## Step 7: Frontend Integration

### Memory Page
- ✅ DragDropFileUpload component added
- ✅ Upload button in header
- ⏳ File browser view (next step)

### File Browser Component (TODO)
Create `FileBrowser.jsx` to display:
- Grid/List view toggle
- Folder navigation
- File previews
- Search functionality

## Step 8: AI Chat Integration

Enhance `MemoryChat.jsx` to:
1. Search files when user asks questions
2. Include file context in AI prompts
3. Show source files in responses

## Next Steps

1. **Implement File Processing Worker**
   - Create background job processor
   - Handle text extraction
   - Generate embeddings
   - Auto-tag files

2. **Build File Browser UI**
   - Grid/List view
   - Folder navigation
   - File preview modal
   - Download functionality

3. **Enhance AI Search**
   - Integrate vector search
   - Add file context to chat
   - Show source citations

4. **Add File Management**
   - Rename files
   - Move to folders
   - Delete files
   - Share files (future)

## Testing Checklist

- [ ] Can upload single file
- [ ] Can upload multiple files
- [ ] Can upload folder structure
- [ ] Files appear in database
- [ ] Files stored in Supabase Storage
- [ ] Text extraction works for PDFs
- [ ] Embeddings generated and stored
- [ ] Vector search returns relevant files
- [ ] AI chat can find files
- [ ] Auto-folder suggestions work

## Performance Considerations

1. **Large Files**: Implement chunked uploads
2. **Many Files**: Add pagination to file browser
3. **Vector Search**: Tune `ivfflat` index parameters
4. **Processing**: Use job queue (BullMQ/Celery) for async processing

## Security Checklist

- [ ] RLS policies tested
- [ ] Storage policies tested
- [ ] File size limits enforced
- [ ] MIME type validation
- [ ] User can only access own files
- [ ] No SQL injection vulnerabilities
