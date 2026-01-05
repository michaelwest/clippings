const form = document.getElementById('bundle-form');
const urlsInput = document.getElementById('urls');
const emailInput = document.getElementById('alt-email');
const statusEl = document.getElementById('status');
const submitBtn = document.getElementById('submit-btn');
const emailBtn = document.getElementById('email-btn');
const downloadWrap = document.getElementById('download');
const downloadLink = document.getElementById('download-link');

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
  emailBtn.disabled = isLoading;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();

  const urls = urlsInput.value
    .split(/\n|,/)
    .map((u) => u.trim())
    .filter(Boolean);

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
      body: JSON.stringify({ urls })
    });

    if (!response.ok) {
      await logAndThrow(response, 'Request failed.');
    }

    const skippedHeader = response.headers.get('x-clippings-skipped') || '';
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);

    downloadLink.href = url;
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

emailBtn.addEventListener('click', async () => {
  const urls = urlsInput.value
    .split(/\n|,/)
    .map((u) => u.trim())
    .filter(Boolean);

  if (!urls.length) {
    setStatus('Add at least one URL.');
    return;
  }

  const altEmail = (emailInput.value || '').trim();
  if (altEmail && !altEmail.includes('@')) {
    setStatus('Enter a valid email address.');
    return;
  }

  setStatus(altEmail ? 'Building PDF and emailing your address…' : 'Building PDF and emailing to Kindle…');
  toggleLoading(true);
  downloadWrap.classList.add('hidden');

  try {
    const response = await fetch('/api/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls, email: altEmail || undefined })
    });

    if (!response.ok) {
      await logAndThrow(response, 'Email failed.');
    }

    const payload = await response.json().catch(() => ({}));
    if (Array.isArray(payload.skipped) && payload.skipped.length) {
      setStatus(
        `${altEmail ? 'Sent to your email address' : 'Sent to Kindle address'}, but some links failed: ${payload.skipped.join(', ')}.`
      );
    } else {
      setStatus(altEmail ? 'Sent to your email address.' : 'Sent to Kindle address.');
    }
  } catch (err) {
    console.error(err);
    setStatus(err.message || 'Something went wrong.');
  } finally {
    toggleLoading(false);
  }
});
