//PSPが配布するスクリプト。加盟店のページ内に決済フォームを組み立て、
//入力されたカード情報をPSPへ直接送信する(JavaScriptフォーム型)
(function(){
    const PSP_ORIGIN = 'http://127.0.0.1:8081';
    const CHARGE_URL = PSP_ORIGIN + '/charge';

    const FORM_HTML = `
<form id="payment-form" method="POST" autocomplete="off">
  <label for="cardnumber">カード番号</label>
  <input type="text" id="cardnumber" name="cardnumber" inputmode="numeric" autocomplete="off" required>

  <label for="exp">有効期限(MM/YY)</label>
  <input type="text" id="exp" name="exp" placeholder="12/30" autocomplete="off" required>

  <label for="cvc">セキュリティコード</label>
  <input type="text" id="cvc" name="cvc" inputmode="numeric" autocomplete="off" required>

  <input type="hidden" id="order" name="order">

  <button type="submit" id="pay-button">支払う</button>
</form>
<p id="payment-status"></p>`;

    //selector: フォームを置く要素 / options.order: 注文ID / options.onPaymentResult: 成功時に呼ぶ関数
    function mount(selector, options){
        document.querySelector(selector).innerHTML = FORM_HTML;
        document.getElementById('order').value = options.order;

        //フォームの入力内容を送信用の形式にまとめる
        function collectCardData(){
            return new URLSearchParams(new FormData(document.getElementById('payment-form')));
        }

        async function submitPayment(event){
            event.preventDefault();
            const response = await fetch(CHARGE_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: collectCardData().toString(),
            });
            const result = await response.json();
            if(result.status !== 'ok'){
                document.getElementById('payment-status').textContent = result.error;
                return;
            }
            options.onPaymentResult(result);
        }

        document.getElementById('payment-form').addEventListener('submit', submitPayment);
    }

    window.PSP = { mount: mount };
})();
