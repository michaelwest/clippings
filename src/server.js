const express = require('express');
const path = require('path');
const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');
const PDFDocument = require('pdfkit');
const nodemailer = require('nodemailer');
const fs = require('fs');

require('dotenv').config();

const MAX_IMG_HEIGHT = 226.8; // ~8cm in points

const PORT = process.env.PORT || 3000;
const app = express();

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// Simple fetch wrapper to ensure a user agent is sent.
async function fetchWithUA(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (compatible; ArticlePdfBot/1.0; +https://example.com)'
    }
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
  }

  return res;
}

function cleanText(text) {
  return text.replace(/\s+/g, ' ').trim();
}

function isNoiseText(text) {
  const t = cleanText(text || '').toLowerCase();
  if (!t) return true;

  const phrases = [
    'follow this publication',
    'follow us on',
    'follow me on',
    'keep up with our latest articles',
    'support our work',
    'subscribe below',
    'subscribe',
    'ready for more',
    'discussion about this post',
    'join the discussion',
    'sign up for our newsletter',
    'receive pieces like this in your inbox',
    'get new posts',
    'become a subscriber',
    'unlock full access'
  ];

  return phrases.some((p) => t.includes(p));
}

function resolveUrl(src, baseUrl) {
  try {
    return new URL(src, baseUrl).href;
  } catch (err) {
    return null;
  }
}

function extractBlocks(contentHtml, baseUrl) {
  const dom = new JSDOM(contentHtml, { url: baseUrl });
  const { document, Node } = dom.window;
  const blocks = [];

  const pushText = (text) => {
    const cleaned = cleanText(text || '');
    if (cleaned && !isNoiseText(cleaned)) {
      blocks.push({ type: 'text', text: cleaned });
    }
  };

  const pushHeading = (text, tag) => {
    const cleaned = cleanText(text || '');
    if (cleaned && !isNoiseText(cleaned)) {
      blocks.push({
        type: 'heading',
        level: Number(tag[1]) || 2,
        text: cleaned
      });
    }
  };

  const traverse = (node) => {
    if (!node) return;

    if (node.nodeType === Node.ELEMENT_NODE) {
      const tag = node.tagName;

      if (/^H[1-6]$/.test(tag)) {
        pushHeading(node.textContent, tag);
        return; // avoid double-counting children
      }

      if (tag === 'P' || tag === 'LI' || tag === 'BLOCKQUOTE') {
        pushText(node.textContent);
        return; // avoid double-counting children
      }

      if (tag === 'FIGURE') {
        const img = node.querySelector('img');
        if (img && img.src) {
          const resolved = resolveUrl(img.src, baseUrl);
          if (resolved) {
            blocks.push({ type: 'image', src: resolved });
          }
        }
        const caption = node.querySelector('figcaption');
        if (caption) {
          pushText(caption.textContent);
        }
        return;
      }

      if (tag === 'IMG' && node.src) {
        const resolved = resolveUrl(node.src, baseUrl);
        if (resolved) {
          blocks.push({ type: 'image', src: resolved });
        }
        return;
      }
    }

    if (node.nodeType === Node.TEXT_NODE) {
      pushText(node.textContent);
      return;
    }

    node.childNodes.forEach(traverse);
  };

  traverse(document.body);
  return blocks;
}

function findPrintableUrl(html, baseUrl) {
  const dom = new JSDOM(html, { url: baseUrl });
  const { document } = dom.window;

  const link = document.querySelector('link[rel="alternate"][media*="print"]');
  if (link && link.href) {
    return resolveUrl(link.href, baseUrl);
  }

  const anchor = Array.from(document.querySelectorAll('a'))
    .map((a) => [a, (a.textContent || '').trim().toLowerCase()])
    .find(([, text]) => text === 'print' || text === 'printer-friendly' || text === 'print view');

  if (anchor && anchor[0].href) {
    return resolveUrl(anchor[0].href, baseUrl);
  }

  return null;
}

async function fetchArticle(url) {
  let res = await fetchWithUA(url);
  let html = await res.text();

  const printableUrl = findPrintableUrl(html, url);
  if (printableUrl && printableUrl !== url) {
    res = await fetchWithUA(printableUrl);
    html = await res.text();
  }

  const dom = new JSDOM(html, { url });
  const reader = new Readability(dom.window.document);
  const article = reader.parse();

  if (!article || !article.content) {
    throw new Error(`Could not parse article at ${url}`);
  }

  const blocks = extractBlocks(article.content, url);

  return {
    title: article.title || url,
    byline: article.byline,
    blocks
  };
}

async function fetchImageBuffer(src) {
  const res = await fetchWithUA(src);
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

function loadFonts(doc) {
  const fontsDir = path.join(__dirname, '..', 'fonts');
  const goudyCandidates = [
    path.join(fontsDir, 'GoudyBookletter1911.ttf'),
    path.join(fontsDir, 'goudy_bookletter_1911.otf')
  ];
  const goudyBoldCandidates = []; // none provided; reuse regular
  const hoeflerPaths = [
    '/Library/Fonts/Hoefler Text.ttf',
    '/System/Library/Fonts/Hoefler Text.ttf',
    '/System/Library/Fonts/Supplemental/Hoefler Text.ttf',
    '/System/Library/Fonts/Hoefler Text.ttc'
  ];
  const hoeflerBoldPaths = [
    '/Library/Fonts/Hoefler Text Bold.ttf',
    '/System/Library/Fonts/Hoefler Text Bold.ttf',
    '/System/Library/Fonts/Supplemental/Hoefler Text Bold.ttf',
    '/System/Library/Fonts/HoeflerText.ttc'
  ];
  const georgiaPaths = [
    '/Library/Fonts/Georgia.ttf',
    '/System/Library/Fonts/Supplemental/Georgia.ttf'
  ];
  const georgiaBoldPaths = [
    '/Library/Fonts/Georgia Bold.ttf',
    '/System/Library/Fonts/Supplemental/Georgia Bold.ttf'
  ];
  const arialPaths = [
    '/Library/Fonts/Arial.ttf',
    '/System/Library/Fonts/Arial.ttf',
    '/System/Library/Fonts/Supplemental/Arial.ttf'
  ];
  const arialBoldPaths = [
    '/Library/Fonts/Arial Bold.ttf',
    '/System/Library/Fonts/Arial Bold.ttf',
    '/System/Library/Fonts/Supplemental/Arial Bold.ttf'
  ];

  const findFont = (paths) => paths.find((p) => fs.existsSync(p));

  const goudyRegular = findFont(goudyCandidates);
  const goudyBold = findFont(goudyBoldCandidates);
  const hoeflerRegular = findFont(hoeflerPaths);
  const hoeflerBold = findFont(hoeflerBoldPaths);
  const georgiaRegular = findFont(georgiaPaths);
  const georgiaBold = findFont(georgiaBoldPaths);
  const arialRegular = findFont(arialPaths);
  const arialBold = findFont(arialBoldPaths);

  if (goudyRegular) {
    doc.registerFont('Goudy', goudyRegular);
  }
  if (goudyBold) {
    doc.registerFont('Goudy-Bold', goudyBold);
  }
  if (hoeflerRegular) {
    doc.registerFont('Hoefler', hoeflerRegular);
  }
  if (hoeflerBold) {
    doc.registerFont('Hoefler-Bold', hoeflerBold);
  }
  if (georgiaRegular) {
    doc.registerFont('Georgia', georgiaRegular);
  }
  if (georgiaBold) {
    doc.registerFont('Georgia-Bold', georgiaBold);
  }
  if (arialRegular) {
    doc.registerFont('Arial', arialRegular);
  }
  if (arialBold) {
    doc.registerFont('Arial-Bold', arialBold);
  }

  const regular =
    (goudyRegular && 'Goudy') ||
    (hoeflerRegular && 'Hoefler') ||
    (georgiaRegular && 'Georgia') ||
    'Times-Roman';
  const bold =
    (goudyBold && 'Goudy-Bold') ||
    (goudyRegular && 'Goudy') || // reuse regular if no bold provided
    (hoeflerBold && 'Hoefler-Bold') ||
    (georgiaBold && 'Georgia-Bold') ||
    'Times-Bold';

  const sansRegular = (arialRegular && 'Arial') || 'Helvetica';
  const sansBold = (arialBold && 'Arial-Bold') || 'Helvetica-Bold';

  return { regular, bold, sansRegular, sansBold };
}

function formattedDate() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function ensureMailer() {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const from = process.env.MAIL_FROM || user;

  if (!host || !user || !pass || !from) {
    throw new Error('Email is not configured. Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, and MAIL_FROM.');
  }

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass }
  });

  return { transporter, from };
}

async function buildPdf(articles) {
  const doc = new PDFDocument({ margin: 50, autoFirstPage: true });
  const buffers = [];

  const fonts = loadFonts(doc);

  doc.on('data', (chunk) => buffers.push(chunk));

  const pageWidth = () =>
    doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const pageBottom = () => doc.page.height - doc.page.margins.bottom;

  const ensureSpace = (needed) => {
    if (doc.y + needed > pageBottom()) {
      doc.addPage();
    }
  };

  const addArticle = async (article, index) => {
    if (index > 0) {
      doc.addPage();
    }

    const width = pageWidth();

    doc.font(fonts.sansBold).fontSize(22).text(article.title || 'Untitled', {
      width
    });

    if (article.byline) {
      doc.moveDown(0.25);
      doc
        .font(fonts.sansRegular)
        .fontSize(12)
        .fillColor('gray')
        .text(article.byline, {
          width
        });
      doc.fillColor('black');
    }

    doc.moveDown(0.75);
    doc.font(fonts.regular).fontSize(12);

    for (const block of article.blocks) {
      if (block.type === 'text') {
        doc
          .font(fonts.regular)
          .fontSize(12)
          .text(block.text, { width, align: 'left' });
        doc.moveDown(0.6);
      } else if (block.type === 'heading') {
        doc.moveDown(0.2);
        const headingSize = 16;
        doc
          .font(fonts.bold)
          .fontSize(headingSize)
          .text(block.text, { width, align: 'left' });
        doc.moveDown(0.4);
        doc.font(fonts.regular).fontSize(12);
      } else if (block.type === 'image') {
        try {
          const imgBuffer = await fetchImageBuffer(block.src);
          const img = doc.openImage(imgBuffer);
          const maxW = width;

          // Calculate scale based on current position.
          const availableNow = Math.max(0, pageBottom() - doc.y - 10);
          const maxHNow = Math.min(MAX_IMG_HEIGHT, availableNow || MAX_IMG_HEIGHT);
          const scaleNow = Math.min(maxW / img.width, maxHNow / img.height, 1);
          const estH = img.height * scaleNow;

          // Ensure we have room (may add a page).
          ensureSpace(estH + 8);

          // Recalculate after potential page break.
          const startY = doc.y || doc.page.margins.top;
          const available = Math.max(0, pageBottom() - startY - 10);
          const maxH = Math.min(MAX_IMG_HEIGHT, available || MAX_IMG_HEIGHT);
          const scale = Math.min(maxW / img.width, maxH / img.height, 1);
          const drawW = img.width * scale;
          const drawH = img.height * scale;

          doc.image(imgBuffer, doc.page.margins.left, startY, {
            width: drawW,
            height: drawH
          });
          doc.y = startY + drawH;
          doc.moveDown(0.6);
        } catch (err) {
          console.warn(`Skipping image ${block.src}: ${err.message}`);
        }
      }
    }
  };

  for (let i = 0; i < articles.length; i++) {
    await addArticle(articles[i], i);
  }

  doc.end();

  return await new Promise((resolve) => {
    doc.on('end', () => {
      resolve(Buffer.concat(buffers));
    });
  });
}

app.post('/api/compile', async (req, res) => {
  const urls = Array.isArray(req.body.urls) ? req.body.urls : [];
  const cleaned = urls
    .map((u) => (typeof u === 'string' ? u.trim() : ''))
    .filter(Boolean);

  if (!cleaned.length) {
    return res.status(400).json({ error: 'Please provide at least one URL.' });
  }

  try {
    const articles = [];
    for (const url of cleaned) {
      const article = await fetchArticle(url);
      articles.push(article);
    }

    const pdfBuffer = await buildPdf(articles);
    const filename = `Articles-${formattedDate()}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(pdfBuffer);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/email', async (req, res) => {
  const urls = Array.isArray(req.body.urls) ? req.body.urls : [];
  const cleaned = urls
    .map((u) => (typeof u === 'string' ? u.trim() : ''))
    .filter(Boolean);

  if (!cleaned.length) {
    return res.status(400).json({ error: 'Please provide at least one URL.' });
  }

  try {
    const articles = [];
    for (const url of cleaned) {
      const article = await fetchArticle(url);
      articles.push(article);
    }

    const pdfBuffer = await buildPdf(articles);
    const filename = `Articles-${formattedDate()}.pdf`;
    const { transporter, from } = ensureMailer();
    await transporter.sendMail({
      from,
      to: 'michael_ead5e5@kindle.com',
      subject: 'convert',
      text: 'Articles attached.',
      attachments: [
        {
          filename,
          content: pdfBuffer
        }
      ]
    });

    return res.json({ status: 'sent' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
