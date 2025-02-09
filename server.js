const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const os = require("os");
const QRCode = require("qrcode");
const fs = require("fs");

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.static("public"));

const DATA_FILE = "merchant_data.json";
let merchantData = {};

// Load existing merchant data
if (fs.existsSync(DATA_FILE)) {
    merchantData = JSON.parse(fs.readFileSync(DATA_FILE));
} else {
    merchantData.qrCode = null;
    merchantData.macAddress = getMacAddress();
    merchantData.files = [];
}

// Get merchant MAC address
function getMacAddress() {
    const networkInterfaces = os.networkInterfaces();
    for (const key in networkInterfaces) {
        for (const net of networkInterfaces[key]) {
            if (!net.internal && net.mac !== "00:00:00:00:00:00") {
                return net.mac;
            }
        }
    }
    return "unknown-mac";
}

// Generate QR Code only once
async function generateQRCode(req) {
    if (!merchantData.qrCode) {
        const host = req.headers.host; // Dynamic host (IP/Domain)
        const protocol = req.protocol; // HTTP or HTTPS
        const url = `${protocol}://${host}/customer.html?merchant=${merchantData.macAddress}`;
        
        merchantData.qrCode = await QRCode.toDataURL(url);
        fs.writeFileSync(DATA_FILE, JSON.stringify(merchantData));
    }
}


generateQRCode();

// Endpoint to get merchant data
app.get("/merchant-data", (req, res) => {
    res.json(merchantData);
});

app.get("/merchant-dashboard", async (req, res) => {
    await generateQRCode(req); // Pass `req` to make host dynamic
    res.render("merchant-dashboard", { qrCode: merchantData.qrCode, transfers: merchantData.files });
});


// WebSocket Communication
io.on("connection", (socket) => {
    console.log("User connected:", socket.id);

    socket.on("join", (merchantId) => {
        socket.join(merchantId);
        io.emit("merchantStatus", "online"); // Notify customers that merchant is online
    });

    socket.on("checkMerchantStatus", (merchantId) => {
        const isMerchantOnline = io.sockets.adapter.rooms.get(merchantId);
        socket.emit("merchantStatus", isMerchantOnline ? "online" : "offline");
    });

    socket.on("sendFile", ({ merchantId, fileData, fileName }) => {
        console.log(`Receiving file: ${fileName}`);

        const fileRecord = { fileName, fileData, timestamp: new Date().toLocaleString() };
        merchantData.files.push(fileRecord);
        fs.writeFileSync(DATA_FILE, JSON.stringify(merchantData));

        io.to(merchantId).emit("receiveFile", fileRecord);
    });

    socket.on("disconnect", () => {
        io.emit("merchantStatus", "offline");
    });
});


server.listen(3000, () => {
    console.log("Server running on http://localhost:3000");
});
