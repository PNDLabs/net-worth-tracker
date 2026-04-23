/**
 * pdfService.js
 *
 * Browser-side PDF text extraction using pdfjs-dist.
 * Used by the Android app's importService when there is no backend server.
 *
 * Works inside Capacitor's WebView (Android) as well as a plain browser.
 */

import * as pdfjsLib from 'pdfjs-dist';
import pdfjsWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';

// Point the worker at the bundled worker file so it does not need a CDN.
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;

/**
 * Extract all text from a PDF given its ArrayBuffer.
 *
 * @param {ArrayBuffer} arrayBuffer  – raw PDF bytes
 * @param {string}      [password]   – optional PDF owner/user password
 * @returns {Promise<string>}        – concatenated text from all pages
 */
export async function extractPdfText(arrayBuffer, password) {
  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(arrayBuffer),
    password: password || '',
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
