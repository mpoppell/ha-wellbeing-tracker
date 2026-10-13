// All URLs are relative so they work behind Home Assistant's ingress path.

function greetingFor(date) {
  const h = date.getHours();
  if (h < 5) return "Good evening";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

function setText(id, text) {
  document.getElementById(id).textContent = text;
}

async function getJSON(path) {
  const resp = await fetch(path, { credentials: "same-origin" });
  if (!resp.ok) throw new Error(`${path} returned ${resp.status}`);
  return resp.json();
}

async function load() {
  const now = new Date();
  setText("today", now.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" }));

  try {
    const me = await getJSON("api/me");
    const name = me.display_name || me.username || "there";
    setText("greeting", `${greetingFor(now)}, ${name.split(" ")[0]}`);
    setText("who", name);

    const status = await getJSON("api/status");
    setText("people", String(status.people));
    setText("version", status.version);

    const ha = document.getElementById("ha-status");
    ha.innerHTML = "";
    const dot = document.createElement("span");
    dot.className = `dot ${status.home_assistant.connected ? "ok" : "bad"}`;
    ha.append(dot, document.createTextNode(status.home_assistant.connected ? "Connected" : "Not connected"));
    ha.title = status.home_assistant.detail;
  } catch (err) {
    const el = document.getElementById("error");
    el.textContent = `Couldn't load: ${err.message}`;
    el.hidden = false;
  }
}

load();
