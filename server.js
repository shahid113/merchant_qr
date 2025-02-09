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
function loadMerchantData() {
    if (fs.existsSync(DATA_FILE)) {
        merchantData = JSON.parse(fs.readFileSync(DATA_FILE));
    } else {
        merchantData = {
            qrCode: null,
            macAddress: null,
            files: []
        };
    }
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

// Check if MAC address has changed and update accordingly
function checkAndUpdateMacAddress() {
    const currentMacAddress = getMacAddress();
    
    // Initialize merchant data if it doesn't exist
    if (!merchantData.macAddress) {
        merchantData.macAddress = currentMacAddress;
        merchantData.qrCode = null;
        return false;
    }
    
    // Check if MAC address has changed
    if (merchantData.macAddress !== currentMacAddress) {
        console.log("MAC address changed. Generating new QR code...");
        merchantData.macAddress = currentMacAddress;
        merchantData.qrCode = null;
        return true;
    }
    
    return false;
}

// Generate QR Code
async function generateQRCode(req) {
    // Check if MAC address has changed or QR code doesn't exist
    const macChanged = checkAndUpdateMacAddress();
    
    if (macChanged || !merchantData.qrCode) {
        const host = req.headers.host;
        const protocol = req.protocol;
        const url = `${protocol}://${host}/customer.html?merchant=${merchantData.macAddress}`;
        
        try {
            merchantData.qrCode = await QRCode.toDataURL(url);
            fs.writeFileSync(DATA_FILE, JSON.stringify(merchantData));
            console.log("New QR code generated successfully");
        } catch (error) {
            console.error("Error generating QR code:", error);
            throw error;
        }
    }
    
    return merchantData.qrCode;
}

// Initialize data on server start
loadMerchantData();

// Endpoint to get merchant data
app.get("/merchant-data", async (req, res) => {
    try {
        // Ensure QR code is up to date with current MAC address
        await generateQRCode(req);
        res.json(merchantData);
    } catch (error) {
        res.status(500).json({ error: "Failed to generate merchant data" });
    }
});

app.get("/merchant-dashboard", async (req, res) => {
    try {
        const qrCode = await generateQRCode(req);
        res.render("merchant-dashboard", { 
            qrCode: qrCode, 
            transfers: merchantData.files 
        });
    } catch (error) {
        res.status(500).send("Error generating dashboard");
    }
});

// WebSocket Communication
io.on("connection", (socket) => {
    console.log("User connected:", socket.id);

    socket.on("join", (merchantId) => {
        socket.join(merchantId);
        io.emit("merchantStatus", "online");
    });

    socket.on("checkMerchantStatus", (merchantId) => {
        const isMerchantOnline = io.sockets.adapter.rooms.get(merchantId);
        socket.emit("merchantStatus", isMerchantOnline ? "online" : "offline");
    });

    socket.on("sendFile", ({ merchantId, fileData, fileName }) => {
        console.log(`Receiving file: ${fileName}`);

        const fileRecord = { 
            fileName, 
            fileData, 
            timestamp: new Date().toLocaleString() 
        };
        merchantData.files.push(fileRecord);
        
        try {
            fs.writeFileSync(DATA_FILE, JSON.stringify(merchantData));
            io.to(merchantId).emit("receiveFile", fileRecord);
        } catch (error) {
            console.error("Error saving file record:", error);
            socket.emit("error", "Failed to save file record");
        }
    });

    socket.on("disconnect", () => {
        io.emit("merchantStatus", "offline");
    });
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).send('Something broke!');
});

server.listen(3000, () => {
    console.log("Server running on http://localhost:3000");
});