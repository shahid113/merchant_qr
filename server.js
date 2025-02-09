const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const os = require("os");
const QRCode = require("qrcode");
const fs = require("fs");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.static("public"));

const DATA_DIR = "merchant_data";
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR);
}

let merchants = {};

// Load existing merchant data
function loadMerchantData(merchantId) {
    const sanitizedMerchantId = merchantId.replace(/:/g, "-");
    const dataFile = path.join(DATA_DIR, `${sanitizedMerchantId}.json`);
    if (fs.existsSync(dataFile)) {
        return JSON.parse(fs.readFileSync(dataFile));
    } else {
        return {
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
function checkAndUpdateMacAddress(merchantId) {
    const currentMacAddress = getMacAddress();
    const merchantData = merchants[merchantId];
    
    // Initialize merchant data if it doesn't exist
    if (!merchantData.macAddress) {
        merchantData.macAddress = currentMacAddress;
        merchantData.qrCode = null;
        return false;
    }
    
    // Check if MAC address has changed
    if (merchantData.macAddress !== currentMacAddress) {
        console.log(`MAC address changed for merchant ${merchantId}. Generating new QR code...`);
        merchantData.macAddress = currentMacAddress;
        merchantData.qrCode = null;
        return true;
    }
    
    return false;
}

// Generate QR Code
async function generateQRCode(req, merchantId) {
    const merchantData = merchants[merchantId];
    const macChanged = checkAndUpdateMacAddress(merchantId);
    
    if (macChanged || !merchantData.qrCode) {
        const host = req.headers.host;
        const protocol = req.protocol;
        const url = `${protocol}://${host}/customer.html?merchant=${merchantData.macAddress}`;
        
        try {
            merchantData.qrCode = await QRCode.toDataURL(url);
            const sanitizedMerchantId = merchantId.replace(/:/g, "-");
            fs.writeFileSync(path.join(DATA_DIR, `${sanitizedMerchantId}.json`), JSON.stringify(merchantData));
            console.log(`New QR code generated successfully for merchant ${merchantId}`);
        } catch (error) {
            console.error(`Error generating QR code for merchant ${merchantId}:`, error);
            throw error;
        }
    }
    
    return merchantData.qrCode;
}

// Function to delete recent transaction files after 2 minutes
function deleteRecentTransactionFiles(merchantId) {
    setTimeout(() => {
        const merchantData = merchants[merchantId];
        if (merchantData && merchantData.files.length > 0) {
            merchantData.files = [];
            const sanitizedMerchantId = merchantId.replace(/:/g, "-");
            fs.writeFileSync(path.join(DATA_DIR, `${sanitizedMerchantId}.json`), JSON.stringify(merchantData));
            console.log(`Deleted recent transaction files for merchant ${merchantId}`);
        }
    }, 2 * 60 * 1000); // 2 minutes
}

// Endpoint to get merchant data
app.get("/merchant-data", async (req, res) => {
    const merchantId = getMacAddress();
    if (!merchants[merchantId]) {
        merchants[merchantId] = loadMerchantData(merchantId);
    }
    try {
        await generateQRCode(req, merchantId);
        res.json(merchants[merchantId]);
    } catch (error) {
        res.status(500).json({ error: "Failed to generate merchant data" });
    }
});

app.get("/merchant-dashboard", async (req, res) => {
    const merchantId = getMacAddress();
    if (!merchants[merchantId]) {
        merchants[merchantId] = loadMerchantData(merchantId);
    }
    try {
        const qrCode = await generateQRCode(req, merchantId);
        res.render("merchant-dashboard", { 
            qrCode: qrCode, 
            transfers: merchants[merchantId].files 
        });
    } catch (error) {
        res.status(500).send("Error generating dashboard");
    }
});

// WebSocket Communication
io.on("connection", (socket) => {
    console.log("User connected:", socket.id);

    socket.on("join", () => {
        const merchantId = getMacAddress();
        socket.join(merchantId);
        io.to(merchantId).emit("merchantStatus", "online");
    });

    socket.on("checkMerchantStatus", () => {
        const merchantId = getMacAddress();
        const isMerchantOnline = io.sockets.adapter.rooms.get(merchantId);
        socket.emit("merchantStatus", isMerchantOnline ? "online" : "offline");
    });

    socket.on("sendFile", ({ fileData, fileName }) => {
        const merchantId = getMacAddress();
        console.log(`Receiving file: ${fileName} for merchant ${merchantId}`);

        if (!merchants[merchantId]) {
            merchants[merchantId] = loadMerchantData(merchantId);
        }

        const fileRecord = { 
            fileName, 
            fileData, 
            timestamp: new Date().toLocaleString() 
        };
        merchants[merchantId].files.push(fileRecord);
        
        try {
            const sanitizedMerchantId = merchantId.replace(/:/g, "-");
            const merchantDir = path.join(DATA_DIR, sanitizedMerchantId);
            if (!fs.existsSync(merchantDir)) {
                fs.mkdirSync(merchantDir);
            }
            fs.writeFileSync(path.join(merchantDir, `${sanitizedMerchantId}.json`), JSON.stringify(merchants[merchantId]));
            io.to(merchantId).emit("receiveFile", fileRecord);

            // Schedule deletion of recent transaction files
            deleteRecentTransactionFiles(merchantId);
        } catch (error) {
            console.error(`Error saving file record for merchant ${merchantId}:`, error);
            socket.emit("error", "Failed to save file record");
        }
    });

    socket.on("disconnect", () => {
        const merchantId = getMacAddress();
        io.to(merchantId).emit("merchantStatus", "offline");
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