// Render messages safely with markdown support
function renderMessage(content, role) {
  const container = document.getElementById('messages-container');
  const msgDiv = document.createElement('div');
  msgDiv.className = `message ${role}`;

  if (role === 'assistant') {
    // Convert Markdown (including HTML code blocks) into highlightable code boxes
    msgDiv.innerHTML = marked.parse(content);
  } else {
    msgDiv.textContent = content;
  }

  container.appendChild(msgDiv);
  
  // Apply code syntax styling
  msgDiv.querySelectorAll('pre code').forEach((block) => {
    hljs.highlightElement(block);
  });

  container.scrollTop = container.scrollHeight;
}

// Mobile sidebar toggle logic
document.getElementById('toggle-sidebar')?.addEventListener('click', () => {
  document.getElementById('sidebar').classList.toggle('open');
});
