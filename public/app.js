const form = document.getElementById('bundle-form');
const urlsInput = document.getElementById('urls');
const statusEl = document.getElementById('status');
const submitBtn = document.getElementById('submit-btn');
const emailDropdown = document.getElementById('email-dropdown');
const emailMenu = document.getElementById('email-menu');
const menuItems = Array.from(document.querySelectorAll('.menu-item'));
const quizToggle = document.getElementById('quiz-toggle');
const downloadWrap = document.getElementById('download');
const downloadLink = document.getElementById('download-link');
const modal = document.getElementById('email-modal');
const modalClose = document.getElementById('modal-close');
const modalCancel = document.getElementById('modal-cancel');
const modalSend = document.getElementById('modal-send');
const emailInput = document.getElementById('alt-email');

function setStatus(message) {
  statusEl.textContent = message;
}

async function logAndThrow(response, fallbackMessage) {
  const text = await response.text().catch(() => '');
  let message = fallbackMessage;

  try {
    const data = JSON.parse(text);
    if (data && typeof data.error === 'string') {
      message = data.error;
    }
    console.error('Server error response:', data);
  } catch {
    if (text) {
      console.error('Server error response:', text);
    } else {
      console.error('Server error response with no body.');
    }
  }

  throw new Error(message);
}

function toggleLoading(isLoading) {
  submitBtn.disabled = isLoading;
  submitBtn.textContent = isLoading ? 'Working…' : 'Create PDF';
  emailDropdown.disabled = isLoading;
  menuItems.forEach((btn) => {
    btn.disabled = isLoading;
  });
}

function toggleMenu(show) {
  const shouldShow = typeof show === 'boolean' ? show : emailMenu.classList.contains('hidden');
  if (shouldShow) {
    emailMenu.classList.remove('hidden');
  } else {
    emailMenu.classList.add('hidden');
  }
}

function closeMenu() {
  emailMenu.classList.add('hidden');
}

function openModal() {
  modal.classList.remove('hidden');
  emailInput.value = '';
  setTimeout(() => emailInput.focus(), 0);
}

function closeModal() {
  modal.classList.add('hidden');
}

function getUrls() {
  return urlsInput.value
    .split(/\n|,/)
    .map((u) => u.trim())
    .filter(Boolean);
}

function includeQuiz() {
  return !!quizToggle?.checked;
}

function clippingsFilename() {
  const today = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const date = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  return `Clippings-${date}.pdf`;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();

  const urls = getUrls();

  if (!urls.length) {
    setStatus('Add at least one URL.');
    return;
  }

  setStatus('Fetching articles and building your PDF…');
  toggleLoading(true);
  downloadWrap.classList.add('hidden');

  try {
    const response = await fetch('/api/compile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls, includeQuiz: includeQuiz() })
    });

    if (!response.ok) {
      await logAndThrow(response, 'Request failed.');
    }

    const skippedHeader = response.headers.get('x-clippings-skipped') || '';
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);

    downloadLink.href = url;
    downloadLink.download = clippingsFilename();
    downloadWrap.classList.remove('hidden');
    if (skippedHeader.trim()) {
      const skipped = skippedHeader
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean);
      setStatus(`Ready. Some links failed: ${skipped.join(', ')}.`);
    } else {
      setStatus('Ready. Download your PDF below.');
    }
  } catch (err) {
    console.error(err);
    setStatus(err.message || 'Something went wrong.');
  } finally {
    toggleLoading(false);
  }
});

async function sendEmail(destinationEmail) {
  const urls = getUrls();

  if (!urls.length) {
    setStatus('Add at least one URL.');
    return;
  }

  const isAlternate = Boolean(destinationEmail);

  if (isAlternate) {
    if (!destinationEmail || !destinationEmail.includes('@')) {
      setStatus('Enter a valid email address.');
      return;
    }
  }

  closeMenu();
  closeModal();

  setStatus(isAlternate ? 'Building PDF and emailing your address…' : 'Building PDF and emailing to Kindle…');
  toggleLoading(true);
  downloadWrap.classList.add('hidden');

  try {
    const response = await fetch('/api/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        urls,
        email: isAlternate ? destinationEmail : undefined,
        includeQuiz: includeQuiz()
      })
    });

    if (!response.ok) {
      await logAndThrow(response, 'Email failed.');
    }

    const payload = await response.json().catch(() => ({}));
    if (Array.isArray(payload.skipped) && payload.skipped.length) {
      setStatus(
        `${isAlternate ? 'Sent to your email address' : 'Sent to Kindle address'}, but some links failed: ${payload.skipped.join(', ')}.`
      );
    } else {
      setStatus(isAlternate ? 'Sent to your email address.' : 'Sent to Kindle address.');
    }
  } catch (err) {
    console.error(err);
    setStatus(err.message || 'Something went wrong.');
  } finally {
    toggleLoading(false);
  }
}

emailDropdown.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleMenu();
});

menuItems.forEach((btn) => {
  btn.addEventListener('click', (event) => {
    const action = event.currentTarget.dataset.action;
    if (action === 'default-send') {
      sendEmail();
    } else if (action === 'alternate-send') {
      openModal();
    }
  });
});

modalClose.addEventListener('click', closeModal);
modalCancel.addEventListener('click', closeModal);

modalSend.addEventListener('click', () => {
  const altEmail = (emailInput.value || '').trim();
  sendEmail(altEmail);
});

document.addEventListener('click', (event) => {
  if (!emailMenu.contains(event.target) && !emailDropdown.contains(event.target)) {
    closeMenu();
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    closeMenu();
    closeModal();
  }
});
