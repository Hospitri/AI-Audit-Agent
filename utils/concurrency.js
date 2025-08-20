let inFlight = 0;
const MAX = parseInt(process.env.GLOBAL_MAX_CONCURRENCY || '3', 10);
const queue = [];

function acquire() {
    return new Promise(resolve => {
        const tryStart = () => {
            if (inFlight < MAX) {
                inFlight++;
                resolve(() => {
                    inFlight--;
                    const next = queue.shift();
                    if (next) next();
                });
            } else {
                queue.push(tryStart);
            }
        };
        tryStart();
    });
}

module.exports = { acquire };
