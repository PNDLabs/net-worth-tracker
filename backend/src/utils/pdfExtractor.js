/**
 * pdfExtractor.js
 * Extracts plain text from a PDF buffer using pdfjs-dist (ESM-only, so we
 * use dynamic import() from CJS).  Supports optional password-protected PDFs.
 */

let _pdfjsLib = null;

async function getPdfjs() {
  if (!_pdfjsLib) {
    _pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  }
  return _pdfjsLib;
}

/**
 * @param {Buffer} buffer      – raw PDF bytes
 * @param {string} [password]  – optional owner/user password
 * @returns {Promise<string>}  – concatenated text from all pages
 */
async function extractPdfText(buffer, password) {
  const pdfjsLib = await getPdfjs();

  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(buffer),
    password: password || '',
    // Suppress missing-font warnings in Node environment
    verbosity: 0,
  });

  let pdf;
  try {
    pdf = await loadingTask.promise;
  } catch (err) {
    if (err.name === 'PasswordException') {
      const msg =
        err.code === 1
          ? 'This PDF is password-protected. Please provide the correct password.'
          : 'Incorrect password for this PDF.';
      const error = new Error(msg);
      error.code = 'PASSWORD_REQUIRED';
      throw error;
    }
    throw err;
  }

  const pageTexts = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items.map((item) => item.str).join(' ');
    pageTexts.push(pageText);
  }

  return pageTexts.join('\n');
}

module.exports = { extractPdfText };
