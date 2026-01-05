const express = require('express');
const path = require('path');
const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');
const PDFDocument = require('pdfkit');
const nodemailer = require('nodemailer');
const fs = require('fs');

require('dotenv').config();

const MAX_IMG_HEIGHT = 226.8; // ~8cm in points
const DEFAULT_KINDLE_EMAIL = process.env.DEFAULT_KINDLE_EMAIL;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

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

function createDom(html, url) {
  try {
    return new JSDOM(html, { url });
  } catch (err) {
    const msg = err && err.message ? err.message : 'Unknown parse error';
    throw new Error(`Failed to parse HTML for ${url}: ${msg}`);
  }
}

function extractBlocks(contentHtml, baseUrl) {
  const dom = createDom(contentHtml, baseUrl);
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
  const dom = createDom(html, baseUrl);
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

  const dom = createDom(html, url);
  const reader = new Readability(dom.window.document);
  const article = reader.parse();

  if (!article || !article.content) {
    throw new Error(`Could not parse article at ${url}`);
  }

  const blocks = extractBlocks(article.content, url);

  return {
    title: article.title || url,
    byline: article.byline,
    url,
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

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function collectArticles(urls) {
  const articles = [];
  const skipped = [];

  for (const url of urls) {
    try {
      const article = await fetchArticle(url);
      articles.push(article);
    } catch (err) {
      console.error(`Failed to fetch/parse ${url}:`, err.message || err);
      skipped.push(url);
    }
  }

  return { articles, skipped };
}

function buildArticleSummary(article, maxChars = 1400) {
  const textBlocks = article.blocks
    .filter((b) => b.type === 'text' || b.type === 'heading')
    .map((b) => b.text)
    .join(' ');
  return (article.title ? `${article.title}. ` : '') + textBlocks.slice(0, maxChars);
}

async function generateComprehension(articles) {
  if (!OPENAI_API_KEY) {
    console.warn('OPENAI_API_KEY not set; skipping comprehension generation.');
    return null;
  }

  const payloadArticles = articles.map((article, idx) => ({
    title: article.title || `Article ${idx + 1}`,
    summary: buildArticleSummary(article)
  }));

  const messages = [
    {
      role: 'system',
      content:
        'You generate concise reading comprehension questions and answers.'
    },
    {
      role: 'user',
      content: [
        'For each article, create 5 questions: 3 about general themes/claims and 2 about memorable specific details.',
        'Return JSON with this shape: [{"title": "...", "questions": ["q1", ...], "answers": ["a1", ...]}].',
        'Questions should be standalone and not reference numbering from the source.',
        'Answers should be brief but specific.',
        'Use the provided article summaries below.',
        '',
        JSON.stringify(payloadArticles, null, 2)
      ].join('\n')
    }
  ];

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages,
        temperature: 0.4,
        max_tokens: 1200
      })
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`OpenAI request failed: ${res.status} ${res.statusText} ${text}`);
    }

    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content || '';
    const fencedJson = content.match(/```json\s*([\s\S]*?)```/i);
    const fencedAny = content.match(/```[\s\S]*?```/i);
    const jsonText = fencedJson ? fencedJson[1] : fencedAny ? fencedAny[0].replace(/```/g, '') : content;
    const parsed = JSON.parse(jsonText);
    if (!Array.isArray(parsed)) {
      throw new Error('Unexpected comprehension response shape.');
    }
    return parsed;
  } catch (err) {
    console.error('Failed to generate comprehension questions:', err.message || err);
    return null;
  }
}

async function buildPdf(articles, comprehension) {
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

    if (article.url) {
      doc.moveDown(article.byline ? 0.15 : 0.3);
      doc
        .font(fonts.sansRegular)
        .fontSize(10)
        .fillColor('blue')
        .text(article.url, { width, link: article.url, underline: true });
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

  const width = pageWidth();

  if (comprehension && comprehension.length) {
    doc.addPage();
    doc.font(fonts.sansBold).fontSize(20).text('Comprehension', { width });
    doc.moveDown(0.6);

    comprehension.forEach((section) => {
      doc
        .font(fonts.bold)
        .fontSize(14)
        .text(section.title || 'Untitled', { width });
      doc.moveDown(0.3);
      (section.questions || []).forEach((q, idx) => {
        doc
          .font(fonts.regular)
          .fontSize(12)
          .text(`${idx + 1}. ${q}`, { width });
        doc.moveDown(0.4);
      });
      doc.moveDown(0.6);
    });

    doc.addPage();
    doc.font(fonts.sansBold).fontSize(20).text('Answers', { width });
    doc.moveDown(0.6);
    comprehension.forEach((section) => {
      doc
        .font(fonts.bold)
        .fontSize(14)
        .text(section.title || 'Untitled', { width });
      doc.moveDown(0.3);
      const answers = section.answers || [];
      const questions = section.questions || [];
      const count = Math.min(answers.length, questions.length || answers.length);
      for (let i = 0; i < count; i++) {
        const label = questions[i] ? `Q${i + 1}` : `${i + 1}`;
        doc
          .font(fonts.regular)
          .fontSize(12)
          .text(`${label}: ${answers[i]}`, { width });
        doc.moveDown(0.3);
      }
      doc.moveDown(0.6);
    });
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
  const includeQuiz = req.body.includeQuiz !== false;

  if (!cleaned.length) {
    return res.status(400).json({ error: 'Please provide at least one URL.' });
  }

  try {
    const { articles, skipped } = await collectArticles(cleaned);

    if (!articles.length) {
      return res.status(502).json({ error: 'Could not fetch any articles.' });
    }

    const comprehension = includeQuiz ? await generateComprehension(articles) : null;
    const pdfBuffer = await buildPdf(articles, comprehension);
    const filename = `Clippings-${formattedDate()}.pdf`;
    if (skipped.length) {
      res.setHeader('X-Clippings-Skipped', skipped.join(','));
    }
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
  const requestedEmail = typeof req.body.email === 'string' ? req.body.email.trim() : '';
  const includeQuiz = req.body.includeQuiz !== false;

  if (!cleaned.length) {
    return res.status(400).json({ error: 'Please provide at least one URL.' });
  }

  if (requestedEmail && !isValidEmail(requestedEmail)) {
    return res.status(400).json({ error: 'Please provide a valid email address.' });
  }

  try {
    const { articles, skipped } = await collectArticles(cleaned);

    if (!articles.length) {
      return res.status(502).json({ error: 'Could not fetch any articles.' });
    }

    const comprehension = includeQuiz ? await generateComprehension(articles) : null;
    const pdfBuffer = await buildPdf(articles, comprehension);
    const filename = `Clippings-${formattedDate()}.pdf`;
    const { transporter, from } = ensureMailer();
    const destination = requestedEmail || DEFAULT_KINDLE_EMAIL;
    if (!destination) {
      return res.status(400).json({ error: 'No destination email configured. Set DEFAULT_KINDLE_EMAIL or provide an email.' });
    }
    const subject = requestedEmail ? `Clippings Articles ${formattedDate()}` : 'convert';
    await transporter.sendMail({
      from,
      to: destination,
      subject,
      text: 'Articles attached.',
      attachments: [
        {
          filename,
          content: pdfBuffer
        }
      ]
    });

    return res.json({ status: 'sent', skipped });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
