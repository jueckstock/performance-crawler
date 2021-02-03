'use strict';

const am = require('am');

const { Session } = require('./lib/launch');
const utils = require('./lib/utils');

const CHROME_EXE = process.env.CHROME_EXE || '/usr/bin/google-chrome'
const USE_XVFB = !!process.env.USE_XVFB
const LOAD_COUNT = +process.env.SPIDER_LINKS || 10
const NAV_TIMEOUT = 30.0 * 1000
const LOITER_TIMEOUT = 30.0 * 1000
const NAV_COMPLETE_EVENT = 'domcontentloaded'
const MAX_CRAWL_TIME = 180.0 * 1000
const COOLOFF_TIMEOUT = 3.0 * 1000


const doPerformanceCrawl = async (browser, targetUrl, visitCount, recordMetrics) => {

    const allEventLogs = [];
    let currentEventLog = [];
    const rotateLog = () => {
        allEventLogs.push(currentEventLog);
        currentEventLog = [];
    };
    const log = (msg, ...args) => {
        const ts = +new Date();
        const deltaTs = currentEventLog.length > 0 ? (ts - currentEventLog[0].ts) : NaN;

        currentEventLog.push({
            ts: ts,
            deltaTs: deltaTs,
            msg: msg,
            args: args,
        })
    }
    const logWith = (msg, converter) => {
        converter = converter || ((...args) => args.map(JSON.stringify));
        return (...args) => {
            log(msg, ...converter(...args));
        }
    };
    const instrumentPage = async (page) => {
        page.setDefaultTimeout(NAV_TIMEOUT);
        page.on('domcontentloaded', logWith("domContentLoaded"));
        page.on('load', logWith('load'));
        page.on('pageerror', logWith('pageError', (error) => [error.message]));
        page.on('framenavigated', logWith('frameNavigated', (frame) => [{name: frame.name(), url: frame.url()}]));
        await page.setCacheEnabled(false);
    };
    
    let page = await browser.newPage();
    for (let visitIndex = 0; visitIndex < visitCount; ++visitIndex) {
        log(`starting visit ${visitIndex}`);
        await instrumentPage(page);

        log(`navigating to ${targetUrl}`);
        const loadEvent = page.waitForNavigation();
        page.goto(targetUrl);

        log(`waiting for load/timeout`);
        await Promise.race([
            loadEvent,
            page.waitForTimeout(LOITER_TIMEOUT),
        ])

        log(`capturing page metrics post-load/loiter`, await page.metrics());

        log(`cooling down/rotating logs/pages for next visit`);
        const [ newPage, ..._ ] = await Promise.all([
            browser.newPage(),
            page.close(),
            timeoutIn(COOLOFF_TIMEOUT),
        ]);
        page = newPage;
        rotateLog();
    }

    await recordMetrics({
        eventLogs: allEventLogs,
    })
};

const timeoutIn = (ms) => new Promise((resolve, _) => { setTimeout(resolve, ms) });

am(async (targetUrl) => {

    const session = new Session();
    session.useBinary(CHROME_EXE).useTempProfile();
    if (USE_XVFB) {
        session.useXvfb();
    }

    let exitStatus = 0;
    await session.run(async (browser) => {
        await Promise.race([
            doPerformanceCrawl(browser, targetUrl, LOAD_COUNT, (metrics) => {
                const { eventLogs } = metrics;
                for (let i = 0; i < eventLogs.length; ++i) {
                    const eventLog = eventLogs[i];
                    for (const event of eventLog) {
                        console.log(i, event.ts, event.deltaTs, event.msg, event.args);
                    }
                }
            }),
            timeoutIn(MAX_CRAWL_TIME),
        ])
    }).catch(err => {
        console.error(`error browsing ${targetUrl}::`, err);
        exitStatus = 1;
    });

    process.exit(exitStatus);
})
