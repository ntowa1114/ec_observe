const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MERCHANT_ORIGIN = 'http://localhost:8080';
const PSP_ORIGIN = 'http://127.0.0.1:8081';
const TEST_PAN = '4111111111111111'; //クレカ番号

const CONTENT_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
};

function readBody(req){
    return new Promise((resolve)=>{
        let data='';
        // ① データが小分けで届くたびに文字列を結合する
        req.on('data', (chunk) => {data += chunk; });
         // ② すべてのデータを受信し終えたら完了（resolve）
        req.on('end',() => {resolve(data);});
    });
}

//指定したファイルをディスクから読んで、そのままブラウザに返す
function serve(res, file){
    //__dirname→このserver.jsがあるフォルダ　path.joinでフルパス
    fs.readFile(path.join(__dirname, file),(err, buf) => {
        if(err){
            res.writeHead(404);
            res.end('file no found');
            return;
        }
        res.writeHead(200,{'Content-Type': CONTENT_TYPES[path.extname(file)] || 'text/plain; charset=utf-8'});
        res.end(buf);
    })
}

function sendJson(res, status, obj, headers = {}){
    res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', ...headers});
    res.end(JSON.stringify(obj));
}

function redirect(res, status, location){
    res.writeHead(status, {'Location': location});
    res.end();
}

function newId(prefix){
    return prefix + crypto.randomBytes(8).toString('hex');
}

function isOrderId(order){
    return /^ord_[0-9a-f]{16}$/.test(order || '');
}

//-------------------- 加盟店サーバー(8080) --------------------

//URLパス → 返すファイル
const MERCHANT_FILES = {
    '/': 'merchant/index.html',
    '/done': 'merchant/done.html',
    '/style.css': 'shared/style.css',
    '/stripe-test.html': 'stripe-test.html', //Stripe Elementsテストページ
};

//決済方式ごとのチェックアウトページ
const CHECKOUT_FILES = {
    '/checkout/redirect': 'merchant/checkout-redirect.html',
    '/checkout/iframe': 'merchant/checkout-iframe.html',
    '/checkout/directpost': 'merchant/checkout-directpost.html',
    '/checkout/jsform': 'merchant/checkout-jsform.html',
    '/checkout/api': 'merchant/checkout-api.html',
};

//API型: 加盟店サーバーからPSPへサーバー間通信でカード情報を転送する
function forwardToPsp(body){
    return new Promise((resolve) => {
        const pspReq = http.request(PSP_ORIGIN + '/api/charge', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(body),
            },
        }, async (pspRes) => {
            const text = await readBody(pspRes);
            try{
                resolve({status: pspRes.statusCode, result: JSON.parse(text)});
            }catch(e){
                resolve({status: 502, result: {status: 'failed', error: 'PSPの応答を解釈できません'}});
            }
        });
        pspReq.on('error', () => {
            resolve({status: 502, result: {status: 'failed', error: 'PSPに接続できません'}});
        });
        pspReq.end(body);
    });
}

http.createServer(async (req, res) => {
    console.log(`受信: ${req.method} ${req.url}`); //ログ
    const url = new URL(req.url, MERCHANT_ORIGIN);

    if(req.method === 'GET' && MERCHANT_FILES[url.pathname]){
        return serve(res, MERCHANT_FILES[url.pathname]);
    }

    if(req.method === 'GET' && CHECKOUT_FILES[url.pathname]){
        //注文IDがなければ発行して付け直す
        if(!isOrderId(url.searchParams.get('order'))){
            return redirect(res, 302, `${url.pathname}?order=${newId('ord_')}`);
        }
        return serve(res, CHECKOUT_FILES[url.pathname]);
    }

    //リダイレクト型: PSPがホストする決済ページへ顧客を送る
    if(req.method === 'POST' && url.pathname === '/checkout/redirect'){
        const params = new URLSearchParams(await readBody(req));
        const order = params.get('order');
        if(!isOrderId(order)){
            res.writeHead(400);
            res.end('bad order');
            return;
        }
        const hosted = new URL('/hosted', PSP_ORIGIN);
        hosted.searchParams.set('order', order);
        hosted.searchParams.set('return_url', MERCHANT_ORIGIN + '/done');
        return redirect(res, 303, hosted.toString());
    }

    //API型: カード情報を加盟店サーバーで受け取り、PSPへ転送する
    if(req.method === 'POST' && url.pathname === '/pay'){
        const body = await readBody(req); // ← 中身を待って受け取る
        const hasPAN = body.includes(TEST_PAN); //カード番号が含まれるか調べる
        console.log(`  └ 中身: ${body} PAN含まれるか=${hasPAN ? 'YES' : 'no'}`); //bodyにはカード番号
        const {status, result} = await forwardToPsp(body);
        return sendJson(res, status, result);
    }

    //iframe型・JavaScriptフォーム型: PSPが発行したトークンだけを受け取る
    if(req.method === 'POST' && url.pathname === '/confirm'){
        const body = await readBody(req);
        const hasPAN = body.includes(TEST_PAN);
        console.log(`  └ 中身: ${body} PAN含まれるか=${hasPAN ? 'YES' : 'no'}`);
        return sendJson(res, 200, {status: 'ok'});
    }

    res.writeHead(404); //Not Found
    res.end('not found')
}).listen(8080, 'localhost', () => {
  console.log('merchant : ' + MERCHANT_ORIGIN + '/');
});

//-------------------- pspサーバー(8081) --------------------

const PSP_FILES = {
    '/hosted': 'psp/hosted.html',
    '/frame': 'psp/frame.html',
    '/psp.js': 'psp/psp.js',
    '/style.css': 'shared/style.css',
};

//加盟店のページから fetch で呼べるようにする(JavaScriptフォーム型)
const CORS_HEADERS = {
    'Access-Control-Allow-Origin': MERCHANT_ORIGIN,
    'Access-Control-Allow-Methods': 'POST',
    'Access-Control-Allow-Headers': 'Content-Type',
};

//カード情報を検証してトークンを発行する(オーソリゼーションの代わり)
function chargeCard(params){
    const order = params.get('order');
    const cardnumber = (params.get('cardnumber') || '').replace(/[\s-]/g, '');
    const exp = params.get('exp') || '';
    const cvc = params.get('cvc') || '';

    if(!isOrderId(order)) return {status: 'failed', order: '', error: '注文IDが不正です'};
    if(!/^\d{13,19}$/.test(cardnumber)) return {status: 'failed', order, error: 'カード番号が不正です'};
    if(!/^(0[1-9]|1[0-2])\/\d{2}$/.test(exp)) return {status: 'failed', order, error: '有効期限が不正です'};
    if(!/^\d{3,4}$/.test(cvc)) return {status: 'failed', order, error: 'セキュリティコードが不正です'};

    return {status: 'ok', order, token: newId('tok_')};
}

//戻り先は加盟店のオリジンに限る
function isMerchantUrl(returnUrl){
    try{
        return new URL(returnUrl).origin === MERCHANT_ORIGIN;
    }catch(e){
        return false;
    }
}

http.createServer(async (req,res) =>{
    console.log(`受信(PSP): ${req.method} ${req.url}`);
    const url = new URL(req.url, PSP_ORIGIN);

    if(req.method === 'GET' && PSP_FILES[url.pathname]){
        return serve(res, PSP_FILES[url.pathname]);
    }

    if(req.method === 'OPTIONS' && url.pathname === '/charge'){
        res.writeHead(204, CORS_HEADERS);
        res.end();
        return;
    }

    //ブラウザから直接カード情報を受け取る(リダイレクト・iframe・ダイレクトポスト・JavaScriptフォーム)
    if (req.method === 'POST' && url.pathname === '/charge'){
        const body = await readBody(req)
        const hasPAN = body.includes(TEST_PAN);
        console.log(`  └ 中身: ${body}  PAN=${hasPAN ? 'YES' : 'no'}`);
        const params = new URLSearchParams(body);
        const result = chargeCard(params);

        //return_url があればフォーム送信なので、加盟店のページへ戻す
        const returnUrl = params.get('return_url');
        if(returnUrl){
            if(!isMerchantUrl(returnUrl)){
                res.writeHead(400);
                res.end('bad return_url');
                return;
            }
            const back = new URL(returnUrl);
            back.searchParams.set('order', result.order);
            back.searchParams.set('status', result.status);
            if(result.token) back.searchParams.set('token', result.token);
            if(result.error) back.searchParams.set('error', result.error);
            return redirect(res, 303, back.toString());
        }

        return sendJson(res, result.status === 'ok' ? 200 : 400, result, CORS_HEADERS);
    }

    //加盟店サーバーからカード情報を受け取る(API型)
    if (req.method === 'POST' && url.pathname === '/api/charge'){
        const body = await readBody(req)
        const hasPAN = body.includes(TEST_PAN);
        console.log(`  └ 中身: ${body}  PAN=${hasPAN ? 'YES' : 'no'}`);
        const result = chargeCard(new URLSearchParams(body));
        return sendJson(res, result.status === 'ok' ? 200 : 400, result);
    }

    res.writeHead(404);
    res.end('not found');

    }).listen(8081,'127.0.0.1', () => {
        console.log('psp : ' + PSP_ORIGIN + '/');

});
