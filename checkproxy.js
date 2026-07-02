import { SocksClient } from 'socks';

async function checkProxy() {
    try {
        const info = await SocksClient.createConnection({
            proxy: { host: '107.150.105.8', port: 1092, type: 5, userId: '9af618454248', password: 'bklpp5xzupld7yvcvejq' },
            destination: { host: 'smtp.gmail.com', port: 587 },
            command: 'connect'
        });
        console.log("✅ Успешно! Соединение с SMTP установлено.");
        info.socket.destroy();
    } catch (err) {
        console.error("❌ Ошибка соединения:", err);
    }
}
checkProxy();