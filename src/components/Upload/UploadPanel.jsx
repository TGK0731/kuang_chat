import React, { useContext, useRef, useState } from 'react';
import { Context } from '../../context/Context';
import './UploadPanel.css';

const UploadPanel = () => {
  const { ragDocs, isRagActive, setIsRagActive, uploadDocument, removeDocument } = useContext(Context);
  const fileInputRef = useRef(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');

  const handleFileSelect = async (e) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    setUploading(true);
    setError('');

    for (const file of files) {
      const ext = file.name.split('.').pop().toLowerCase();
      if (!['txt', 'md', 'pdf'].includes(ext)) {
        setError(`不支持的文件类型: .${ext}`);
        continue;
      }
      try {
        await uploadDocument(file);
      } catch (err) {
        setError(err.message || '上传失败');
      }
    }

    setUploading(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleRemove = async (filename) => {
    try {
      await removeDocument(filename);
    } catch {
      setError('删除失败');
    }
  };

  return (
    <div className="upload-panel">
      <div className="upload-controls">
        <button
          className={`rag-toggle ${isRagActive && ragDocs.length > 0 ? 'active' : ''}`}
          onClick={() => setIsRagActive(!isRagActive)}
          disabled={ragDocs.length === 0}
          title={ragDocs.length === 0 ? '请先上传文档' : isRagActive ? 'RAG 已启用' : 'RAG 已关闭'}
        >
          <span className={`toggle-dot ${isRagActive && ragDocs.length > 0 ? 'on' : ''}`} />
          <span className="toggle-label">RAG</span>
        </button>

        <button
          className="upload-btn"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
        >
          <span className="upload-icon">{uploading ? '⏳' : '+'}</span>
          <span>{uploading ? '上传中...' : '上传文档'}</span>
        </button>

        <input
          ref={fileInputRef}
          type="file"
          accept=".txt,.md,.pdf"
          multiple
          onChange={handleFileSelect}
          style={{ display: 'none' }}
        />
      </div>

      {error && <div className="upload-error">{error}</div>}

      {ragDocs.length > 0 && (
        <div className="doc-pills">
          {ragDocs.map((doc) => (
            <div key={doc.filename} className="doc-pill">
              <span className="doc-icon">
                {doc.filename.endsWith('.pdf') ? '📄' : '📝'}
              </span>
              <span className="doc-name" title={doc.filename}>
                {doc.filename.length > 20
                  ? doc.filename.slice(0, 18) + '...'
                  : doc.filename}
              </span>
              <span className="doc-chunks">{doc.chunkCount}块</span>
              <button
                className="doc-remove"
                onClick={() => handleRemove(doc.filename)}
                title="移除文档"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default UploadPanel;
