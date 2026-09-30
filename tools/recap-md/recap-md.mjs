#!/usr/bin/env node
// recap-md — rewrite markdown/text as natural spoken narration with a local LLM,
// then optionally read it aloud via speak-md. Node 22 ESM, zero dependencies.
//
// Part of Farsight's Model Hub. Runs fully local: the only network call is to
// Ollama on 127.0.0.1. Emits metadata-only start/end markers to the Model Hub
// event stream so the dashboard can show it running.

import { appendFileSync, mkdirSync, readFileSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const MAX_INPUT_BYTES = 2 * 1024 * 1024; // 2 MB input cap (matches speak-md)
const MAX_OUTPUT_CHARS = 200 * 1024; // bound the narration we handle/print
const DEFAULT_MODEL = 'qwen3:4b';
const DEFAULT_OLLAMA = 'http://127.0.0.1:11434';

/**
 * @group Recap tool
 * @business Reads the command a person typed and works out what they want: which
 * rewrite mode, whether to speak it, and which file or piped text to work on.
 */
function parseArgs(argv) {
  const out = { mode: 'recap', speak: false, voice: null, speed: null, help: false, file: null };
  const opts = [];
  let operands = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--') { operands = argv.slice(i + 1); break; }
    opts.push(argv[i]);
  }
  for (let j = 0; j < opts.length; j++) {
    const a = opts[j];
    if (a === '--help' || a === '-h') { out.help = true; return out; }
    else if (a === '--mode') { out.mode = opts[++j]; }
    else if (a === '--speak') { out.speak = true; }
    else if (a === '--voice') { out.voice = opts[++j]; }
    else if (a === '--speed') { out.speed = opts[++j]; }
    else if (a === '-') { throw usage("put the input after '--', e.g. recap-md --mode recap -- -"); }
    else if (a.startsWith('-')) { throw usage(`unknown option '${a}'.`); }
    else { throw usage(`unexpected argument '${a}'. Put the input path after '--', e.g. recap-md --mode recap -- ${a}`); }
  }
  if (out.mode !== 'spoken' && out.mode !== 'recap') throw usage(`--mode must be 'spoken' or 'recap' (got '${out.mode}').`);
  if (operands === null) throw usage("missing '--' before the input path (use: recap-md [options] -- <file|->).");
  if (operands.length === 0) throw usage("no input given after '--'.");
  if (operands.length > 1) throw usage('only one input path is allowed.');
  out.file = operands[0];
  return out;
}

/**
 * @group Recap tool
 * @business Prints the usage guide so someone can see the options and the required
 * dash-dash separator without the tool touching any files or the model.
 */
function printHelp() {
  process.stdout.write(
`recap-md — rewrite content as natural spoken narration with a local LLM.

Usage:
  recap-md --mode spoken|recap [--speak] [--voice <id>] [--speed <f>] -- <file>
  recap-md --mode recap -- -            # read the input from stdin

The input path (or '-') MUST come after a '--' separator.

Modes:
  spoken   Full conversational rewrite: no markdown, abbreviations expanded,
           transitions added, all key information kept.
  recap    A short spoken-style summary (~150-250 words). (default)

Options:
  --speak            Read the result aloud by piping it to speak-md.
  --voice <id>       Voice passed through to speak-md (with --speak).
  --speed <f>        Speech speed passed through to speak-md (with --speak).
  -h, --help         Show this help and exit (never touches files or the model).

Environment:
  MODELHUB_LLM       Ollama model to use (default: ${DEFAULT_MODEL}).
  MODELHUB_DIR       Override the Model Hub data dir (default: ~/.local/share/modelhub).
  MODELHUB_OLLAMA_URL  Override the Ollama base URL (default: ${DEFAULT_OLLAMA}).

Examples:
  recap-md --mode recap -- README.md
  cat NOTES.md | recap-md --mode spoken -- -
  recap-md --mode recap --speak -- README.md
`);
}

/**
 * @group Recap tool
 * @business Loads the text to work on, either from a file or from piped input, and
 * refuses anything larger than two megabytes so the tool never chokes on a huge file.
 */
function readInput(file) {
  let buf;
  if (file === '-') {
    buf = readStdin();
  } else {
    buf = readFileSync(file);
  }
  if (buf.byteLength > MAX_INPUT_BYTES) {
    throw new Error(`recap-md: input larger than ${(MAX_INPUT_BYTES / (1024 * 1024)) | 0} MB, refusing.`);
  }
  const text = buf.toString('utf8').trim();
  if (!text) throw new Error('recap-md: input is empty, nothing to rewrite.');
  return text;
}

/**
 * @group Recap tool
 * @business Reads everything a person or another program pipes in, stopping once the
 * two-megabyte limit is reached so it cannot be flooded.
 */
function readStdin() {
  const chunks = [];
  let total = 0;
  const size = 64 * 1024;
  const tmp = Buffer.alloc(size);
  while (total <= MAX_INPUT_BYTES) {
    let n = 0;
    try {
      n = readSync(0, tmp, 0, size, null);
    } catch (e) {
      if (e && e.code === 'EAGAIN') continue;
      if (e && e.code === 'EOF') break;
      throw e;
    }
    if (n === 0) break;
    chunks.push(Buffer.from(tmp.subarray(0, n)));
    total += n;
  }
  return Buffer.concat(chunks);
}

/**
 * @group Recap tool
 * @business Writes the instructions for the local model, telling it whether to fully
 * narrate the document or boil it down to a short spoken summary.
 */
function buildMessages(mode, content) {
  const spoken =
    'You are a narration rewriter. Rewrite the user\'s document exactly as it would be ' +
    'spoken aloud in natural, flowing, conversational English. Remove every markdown-ism ' +
    '(headings, bullets, links, code fences, emphasis markers). Expand abbreviations and ' +
    'acronyms into spoken words. Add natural transitions between ideas so it reads smoothly ' +
    'when heard. Keep every piece of key information — do not summarize or drop content. ' +
    'Output only the rewritten narration, with no preamble, notes, or markdown.';
  const recap =
    'You are a spoken-style summarizer. Produce a concise summary of the user\'s document ' +
    'as it would be spoken aloud, between 150 and 250 words. Use natural, flowing, ' +
    'conversational English with no markdown formatting of any kind. Capture the main points ' +
    'and key takeaways. Output only the spoken summary, with no preamble, notes, or markdown.';
  return [
    { role: 'system', content: mode === 'spoken' ? spoken : recap },
    { role: 'user', content },
  ];
}

/**
 * @group Recap tool
 * @business Sends the document to the local language model running on this machine and
 * returns its rewritten text, with a clear error if the model service is not running.
 */
async function callModel(model, messages) {
  const base = (process.env.MODELHUB_OLLAMA_URL || DEFAULT_OLLAMA).replace(/\/+$/, '');
  const url = `${base}/api/chat`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: false, think: false, options: { num_ctx: 16384 } }),
    });
  } catch (e) {
    throw new Error(
      `recap-md: cannot reach Ollama at ${base} — is it running? ` +
      `Try 'brew services start ollama'. (${e && e.message ? e.message : e})`,
    );
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`recap-md: Ollama returned ${res.status} ${res.statusText}. ${body.slice(0, 500)}`);
  }
  let data;
  try {
    data = await res.json();
  } catch (e) {
    throw new Error(`recap-md: could not parse Ollama response. (${e && e.message ? e.message : e})`);
  }
  const content = data && data.message && data.message.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('recap-md: Ollama returned no usable content.');
  }
  return content.slice(0, MAX_OUTPUT_CHARS);
}

/**
 * @group Recap tool
 * @business Strips out any hidden chain-of-thought the model may emit so only the clean
 * spoken narration is kept.
 */
function stripThink(text) {
  let t = text;
  // Remove any well-formed <think>…</think> blocks.
  t = t.replace(/<think>[\s\S]*?<\/think>/gi, '');
  // Qwen3 (and friends) often stream reasoning that ends with a closing tag but
  // has no opening one — the opening is implicit. Everything up to and including
  // the last closing tag is hidden reasoning; the real answer follows it.
  const marker = '</think>';
  const close = t.toLowerCase().lastIndexOf(marker);
  if (close !== -1) t = t.slice(close + marker.length);
  // Drop any leftover stray tags.
  t = t.replace(/<\/?think>/gi, '');
  return t.trim();
}

/**
 * @group Recap tool
 * @business Reads the narration aloud by handing it to the speak-md tool and passing
 * along the same exit status, so the whole read-it-to-me chain succeeds or fails together.
 */
function speakText(text, voice, speed) {
  return new Promise((resolve) => {
    const args = [];
    if (voice) args.push('--voice', voice);
    if (speed !== null && speed !== undefined) args.push('--speed', String(speed));
    args.push('--', '-');
    const child = spawn('speak-md', args, { stdio: ['pipe', 'inherit', 'inherit'] });
    child.on('error', (err) => {
      process.stderr.write(`recap-md: could not run speak-md (${err.message}).\n`);
      resolve(127);
    });
    child.on('close', (code) => resolve(code == null ? 1 : code));
    child.stdin.on('error', () => { /* speak-md may exit early; ignore broken pipe */ });
    child.stdin.write(text);
    child.stdin.end();
  });
}

/**
 * @group Recap tool
 * @business Records a one-line metadata marker (start or end, never any content) to the
 * Model Hub event stream so the dashboard can show this tool lighting up while it runs.
 */
function emit(event, model) {
  try {
    const dir = process.env.MODELHUB_DIR || join(homedir(), '.local', 'share', 'modelhub');
    mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({
      ts: Math.floor(Date.now() / 1000),
      source: 'tool',
      tool: 'recap-md',
      model,
      event,
    }) + '\n';
    appendFileSync(join(dir, 'events.jsonl'), line);
  } catch {
    /* fail-silent: telemetry must never affect the tool */
  }
}

/**
 * @group Recap tool
 * @business Builds an error that means "you typed the command wrong" so those get a short
 * usage hint instead of being treated as a real failure.
 */
function usage(msg) {
  const e = new Error(msg);
  e.isUsage = true;
  return e;
}

/**
 * @group Recap tool
 * @business Runs the whole tool end to end: understand the command, read the input, ask
 * the model to rewrite it, then print it or speak it — always closing the event marker.
 */
async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    if (e.isUsage) {
      process.stderr.write(`recap-md: ${e.message}\n`);
      process.stderr.write('Try: recap-md --mode spoken|recap [--speak] [--voice <id>] [--speed <f>] -- <file>\n');
      return 2;
    }
    throw e;
  }

  if (args.help) { printHelp(); return 0; }

  const content = readInput(args.file);
  const model = process.env.MODELHUB_LLM || DEFAULT_MODEL;

  emit('start', model);
  try {
    const messages = buildMessages(args.mode, content);
    const raw = await callModel(model, messages);
    const out = stripThink(raw);
    if (!out) throw new Error('recap-md: model produced an empty narration.');
    if (args.speak) {
      return await speakText(out, args.voice, args.speed);
    }
    process.stdout.write(out + '\n');
    return 0;
  } finally {
    emit('end', model);
  }
}

main()
  .then((code) => process.exit(code || 0))
  .catch((err) => {
    process.stderr.write(`${err && err.message ? err.message : err}\n`);
    process.exit(1);
  });
