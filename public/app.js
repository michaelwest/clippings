const form = document.getElementById('bundle-form');
const urlsInput = document.getElementById('urls');
const statusEl = document.getElementById('status');
const submitBtn = document.getElementById('submit-btn');
const emailBtn = document.getElementById('email-btn');
const downloadWrap = document.getElementById('download');
const downloadLink = document.getElementById('download-link');

function setStatus(message) {
  statusEl.textContent = message;
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
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || 'Request failed.');
    }

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);

    downloadLink.href = url;
    downloadWrap.classList.remove('hidden');
    setStatus('Ready. Download your PDF below.');
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

  setStatus('Building PDF and emailing to Kindle…');
  toggleLoading(true);
  downloadWrap.classList.add('hidden');

  try {
    const response = await fetch('/api/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls })
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || 'Email failed.');
    }

    setStatus('Sent to Kindle address.');
  } catch (err) {
    console.error(err);
    setStatus(err.message || 'Something went wrong.');
  } finally {
    toggleLoading(false);
  }
});
