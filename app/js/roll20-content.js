// Runs on app.roll20.net. Same DOM hooks as the existing roll20-wild-magic
// extension: Roll20's chat textarea (`#textchat-input textarea`) and its
// send button (`#chatSendBtn`). Setting `.value` directly and dispatching an
// `input` event (so Roll20's own listeners notice the change) then clicking
// the real send button is more reliable than trying to submit the form
// programmatically.

/** Tries to find and use the chat box, retrying while the game is still loading. */
function trySend(text) {
  return new Promise((resolve) => {
    function attempt(retriesLeft) {
      const textarea = document.querySelector("#textchat-input textarea");
      const button = document.querySelector("#chatSendBtn");

      if (textarea && button) {
        textarea.value = text;
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
        button.click();
        textarea.value = "";
        resolve(true);
        return;
      }

      if (retriesLeft > 0) {
        setTimeout(() => attempt(retriesLeft - 1), 200);
      } else {
        resolve(false);
      }
    }

    attempt(10);
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "SEND_TO_ROLL20") {
    trySend(message.text).then((ok) => sendResponse({ ok }));
    return true; // async response
  }
});
