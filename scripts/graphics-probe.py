#!/usr/bin/env python3
"""Render Listen's production frontend with synthetic data in system WebKitGTK.
Usage: python3 scripts/graphics-probe.py /path/to/results
Requires PyGObject, GTK3 and WebKit2 4.1. Build dist first with npm run build.
Launch separate processes with the renderer environment options being compared.
Measures six seconds of requestAnimationFrame scrolling, not displayed-frame FPS.
"""
import os, sys, json, threading, http.server, functools, time
from pathlib import Path
import gi
gi.require_version('Gtk', '3.0')
gi.require_version('WebKit2', '4.1')
from gi.repository import Gtk, WebKit2, GLib, Gdk
out = Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)

class QuietHandler(http.server.SimpleHTTPRequestHandler):

    def log_message(self, *args):
        pass
server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(QuietHandler, directory=str(Path(__file__).resolve().parents[1] / 'dist')))
threading.Thread(target=server.serve_forever, daemon=True).start()
meeting = {
    'id': 'probe',
    'projectId': None,
    'folderId': None,
    'position': 0,
    'title': 'Graphics test — synthetic transcript',
    'status': 'ready',
    'createdAt': '2026-09-14T10:00:00Z',
    'startedAt': None,
    'endedAt': None,
    'durationMs': 1000000,
    'audioDirectory': None,
    'errorMessage': None,
}
snapshot = {
    'projects': [],
    'folders': [],
    'meetings': [meeting],
    'people': [],
    'devices': [],
    'settings': {
        'microphoneDeviceId': None,
        'systemDeviceId': None,
        'captureMicrophone': False,
        'captureSystem': False,
        'theme': 'light',
        'apiKeyConfigured': False,
        'pyannoteApiKeyConfigured': False,
        'localSpeakerPersonId': None,
        'preferLocalSpeakerForMicrophone': False,
    },
    'segments': [
        {
            'id': f'seg-{i}',
            'meetingId': 'probe',
            'speakerLabel': str(i % 2),
            'personId': None,
            'identitySource': None,
            'identityConfidence': None,
            'startMs': i * 1000,
            'endMs': (i + 1) * 1000,
            'text': f'Passage {i}. This synthetic transcript tests scrolling and text rendering without accessing any saved conversation. ' + 'Additional sample text to exercise variable row heights. ' * (i % 4),
        }
        for i in range(1000)
    ],
}
manager = WebKit2.UserContentManager()
manager.register_script_message_handler('probe')
seed = 'localStorage.setItem("listen-browser-preview-v1",' + json.dumps(json.dumps(snapshot)) + ');'
manager.add_script(WebKit2.UserScript.new(seed, WebKit2.UserContentInjectedFrames.TOP_FRAME, WebKit2.UserScriptInjectionTime.START, None, None))
view = WebKit2.WebView(web_context=WebKit2.WebContext.new_ephemeral(), user_content_manager=manager)
window = Gtk.Window(title='Listen graphics probe: ' + out.name)
window.set_default_size(1180, 780)
window.add(view)
window.connect('destroy', Gtk.main_quit)
result = {
    'mode': out.name,
    'pid': os.getpid(),
    'webkit': f'{WebKit2.get_major_version()}.{WebKit2.get_minor_version()}.{WebKit2.get_micro_version()}',
    'policy': view.get_settings().get_hardware_acceleration_policy().value_nick,
    'environment': {k: os.environ[k] for k in ['WEBKIT_DISABLE_DMABUF_RENDERER', 'WEBKIT_DMABUF_RENDERER_FORCE_SHM', 'DRI_PRIME', '__EGL_VENDOR_LIBRARY_FILENAMES', 'WEBKIT_WEB_RENDER_DEVICE', 'WEBKIT_WEB_RENDER_DEVICE_FILE'] if k in os.environ},
}
print(json.dumps(result), flush=True)

def finish():
    screen()
    (out / 'result.json').write_text(json.dumps(result, indent=2))
    Gtk.main_quit()
    return False

def screen():
    try:
        pix = Gdk.pixbuf_get_from_window(window.get_window(), 0, 0, 1180, 780)
        pix.savev(str(out / 'window.png'), 'png', [], [])
    except Exception as e:
        result['screenshot_error'] = str(e)
    return False

def message(manager, value):
    data = json.loads(value.get_js_value().to_string())
    if cpu_start:
        data['cpuPercentOneCore'] = round(100 * (tree_ticks() - cpu_start[0]) / os.sysconf('SC_CLK_TCK') / (time.monotonic() - cpu_start[1]), 2)
    result.update(data)
    devices = {}
    for proc in Path('/proc').glob('[0-9]*'):
        try:
            if proc.joinpath('comm').read_text().strip() not in ('WebKitWebProces', 'python3'):
                continue
            if int(proc.name) not in (os.getpid(),) and int(proc.joinpath('status').read_text().split('PPid:')[1].split('\n')[0].strip()) != os.getpid():
                continue
            links = [os.readlink(fd) for fd in proc.joinpath('fd').iterdir()]
            devices[proc.name] = sorted(set((link for link in links if link.startswith(('/dev/dri/', '/dev/nvidia')))))
        except (OSError, IndexError):
            pass
    result['gpu_device_fds'] = devices
    print(json.dumps(data), flush=True)
    screen()
    GLib.timeout_add(200, finish)
manager.connect('script-message-received::probe', message)
cpu_start = None
import importlib.util
spec = importlib.util.spec_from_file_location('sampler', str(Path(__file__).resolve().with_name('profile-linux.py')))
sampler = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sampler)

def tree_ticks():
    table = sampler.processes()
    selected = {os.getpid()}
    while True:
        expanded = selected | {pid for pid, row in table.items() if row['parent'] in selected}
        if expanded == selected:
            break
        selected = expanded
    return sum((table[pid]['ticks'] for pid in selected if pid in table))

def benchmark():
    global cpu_start
    cpu_start = (tree_ticks(), time.monotonic())
    view.evaluate_javascript(script, -1, None, None, None, None, None)
    return False
script = """(() => {
const el=document.querySelector('.transcript-container');
if(!el || document.querySelectorAll('.transcript-row').length<1000){window.webkit.messageHandlers.probe.postMessage(JSON.stringify({error:'Transcript did not load',text:document.body.innerText.slice(0,400)}));return;}
const frames=[];let start,last;
function tick(now){if(start===undefined){start=now;last=now;}else{frames.push(now-last);last=now;}
el.scrollTop=((now-start)*0.25)%(el.scrollHeight-el.clientHeight);
if(now-start<6000)requestAnimationFrame(tick);else{
frames.sort((a,b)=>a-b);const gl=document.createElement('canvas').getContext('webgl');let gpu=null;if(gl){const ext=gl.getExtension('WEBGL_debug_renderer_info');gpu=ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER);}
window.webkit.messageHandlers.probe.postMessage(JSON.stringify({frames:frames.length,elapsedMs:now-start,medianFrameMs:frames[Math.floor(frames.length*.5)],p95FrameMs:frames[Math.floor(frames.length*.95)],framesOver25ms:frames.filter(x=>x>25).length,visibility:document.visibilityState,scrollHeight:el.scrollHeight,webglRenderer:gpu}));}}
requestAnimationFrame(tick);
})();"""

def loaded(view, event):
    if event == WebKit2.LoadEvent.FINISHED:
        GLib.timeout_add(1500, benchmark)
view.connect('load-changed', loaded)
view.connect('web-process-terminated', lambda v, reason: (result.update(error=str(reason)), finish()))
window.show_all()
view.load_uri(f'http://127.0.0.1:{server.server_port}/')
GLib.timeout_add_seconds(16, lambda: (result.update(timeout=True), finish())[1])
Gtk.main()
server.shutdown()
