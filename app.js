// Clicar no vídeo para colocar em tela cheia
videoGrid.addEventListener('click', async (event) => {
  const video = event.target.closest('video');

  if (!video) return;

  try {
    if (!document.fullscreenElement) {
      await video.requestFullscreen();
    } else {
      await document.exitFullscreen();
    }
  } catch (error) {
    // Compatibilidade com alguns celulares
    if (video.webkitEnterFullscreen) {
      video.webkitEnterFullscreen();
    }
  }
});
