// Fixed loopback host probe: no redirects/credentials; original absolute timeout and bounded response.
import { request } from 'node:http';
import { companionOrigin } from '@farsight/core/dist/sentinel-companion.js';
import { OwnerUiError } from './session.js';
export async function ownerHost(origin: string, expected?: string): Promise<{ instance: string; readOnly: boolean }> {
  companionOrigin(origin);
  return new Promise((resolve, reject) => {
    let size = 0,
      done = false;
    const chunks: Buffer[] = [];
    const fail = () => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        req.destroy();
        reject(new OwnerUiError('sentinel.ownerUi.hostUnavailable'));
      }
    };
    const req = request(
      origin + '/api/version',
      {
        method: 'GET',
        agent: false,
        maxHeaderSize: 4096,
        headers: { accept: 'application/json' },
        lookup: (_name, options, callback) => {
          if (options.all) callback(null, [{ address: '127.0.0.1', family: 4 }]);
          else callback(null, '127.0.0.1', 4);
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          fail();
          return;
        }
        res.on('data', (b: Buffer) => {
          size += b.length;
          if (size > 16384) {
            res.destroy();
            fail();
          } else chunks.push(b);
        });
        res.on('error', fail);
        res.on('end', () => {
          if (done) return;
          try {
            const v = JSON.parse(Buffer.concat(chunks).toString('utf8')),
              s = v.session;
            if (
              !s ||
              typeof s.readOnly !== 'boolean' ||
              typeof s.instance !== 'string' ||
              !/^host-[a-f0-9]{32}$/.test(s.instance) ||
              (expected !== undefined && s.instance !== expected)
            )
              throw Error();
            done = true;
            clearTimeout(timer);
            resolve({ instance: s.instance, readOnly: s.readOnly });
          } catch {
            fail();
          }
        });
      },
    );
    const timer = setTimeout(fail, 1500);
    req.on('error', fail);
    req.end();
  });
}
