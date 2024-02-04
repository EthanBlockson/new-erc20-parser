const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const TelegramBot = require('node-telegram-bot-api');
const dotenv = require('dotenv');

// Settings
const wssUrl = process.env.WSS_URL;
const apiUrl = process.env.API_URL;
const ethNodeUrl = process.env.ETH_NODE_URL;
const botToken = process.env.TELEGRAM_BOT_TOKEN;
const channelId = process.env.TELEGRAM_BOT_CHANNEL_ID;
const updateSeconds = 5;

// Initialize the Ethereum node provider
const wssProvider = new ethers.WebSocketProvider(wssUrl);

// Initialize the Ethereum RPC provider
const rpcProvider = new ethers.JsonRpcProvider(ethNodeUrl);

// Initialize the Telegram bot
const bot = new TelegramBot(botToken, { polling: true });

// Create a directory if it doesn't exist
const parserFolder = path.join(__dirname, 'parser');
if (!fs.existsSync(parserFolder)) {
    fs.mkdirSync(parserFolder);
}

// Define file paths
const methodsJSON = path.join(parserFolder, 'methods.json');
const outputJSON = path.join(parserFolder, 'addresses.json');
const outputTXT = path.join(parserFolder, 'addresses.txt');

console.log("Parser is running...")

// Listen node and save addresses, creation methods and symbols
const listenForTransactions = async () => {
    wssProvider.on('block', async (blockNumber) => {
        // Load allowed method signatures from 'methods.json' uniqueNewAddressesinside the async function
        const allowedMethods = JSON.parse(fs.readFileSync(methodsJSON, 'utf-8'));

        // Read blocks
        const block = await wssProvider.getBlock(blockNumber);

        if (block) {
            for (const transactionHash of block.transactions) {
                const transaction = await wssProvider.getTransaction(transactionHash);

                if (transaction) {
                    const inputData = transaction.data;
                    const methodSignature = inputData.slice(0, 10); // Include the '0x' prefix

                    // Get the details of the transaction to extract contract address
                    const nonce = transaction.nonce;
                    const from = transaction.from;

                    // Extract the contract address 
                    const contractAddress = ethers.getCreateAddress({ from, nonce }).toLowerCase();

                    // Check if the method signature is in the allowed methods list
                    if (allowedMethods.includes(methodSignature)) {
                        // Send the message to Telegram channel
                        const message = `${contractAddress}\n${methodSignature}`;
                        await bot.sendMessage(channelId, message);

                        // Transaction meets the criteria
                        const transactionData = {
                            address: contractAddress,
                            method: methodSignature,
                        };

                        // Read existing data from the file
                        const existingData = fs.existsSync(outputJSON)
                            ? JSON.parse(fs.readFileSync(outputJSON, 'utf-8'))
                            : [];

                        // Check if the address is already in the data
                        if (!existingData.some(data => data.address === contractAddress)) {
                            // Add the new data to the beginning of the array
                            existingData.unshift(transactionData);

                            // Write the updated data back to the file
                            fs.writeFileSync(outputJSON, JSON.stringify(existingData, null, 2));
                        }
                    }
                }
            }
        }
    });
};

// Fetch API and save addresses, creation methods, and symbols
async function fetchAndSaveAddresses() {
    try {
        const response = await axios.get(apiUrl);
        const responseData = response.data;

        // Check if the response data has a "data" property which contains an array
        if (responseData && Array.isArray(responseData.data)) {
            const newAddresses = await Promise.all(responseData.data
                .filter(item => item.address && item.name !== "Uniswap V2") // exclude the Uniswap V2 pair tokens
                .map(async item => {
                    const methodHash = await extractMethod(item.creating_transaction_hash); // get the method hash using tx hash
                    return {
                        address: item.address.toLowerCase(), // Normalize to uppercase
                        method: methodHash,
                    };
                }));

            // Read the existing data from the JSON file, if it exists
            const existingAddresses = fs.existsSync(outputJSON)
                ? JSON.parse(fs.readFileSync(outputJSON))
                : [];

            // Filter out existing addresses from the new addresses
            const uniqueNewAddresses = newAddresses.filter(address => !existingAddresses.some(existing => existing.address === address.address));

            // Merge unique new addresses with existing addresses
            const mergedAddresses = uniqueNewAddresses.concat(existingAddresses);

            // Send the message to Telegram channel
            if (uniqueNewAddresses.length > 0) {
                uniqueNewAddresses.forEach(async (address) => {
                    const message = `${address.address}\n${address.method}`;
                    await bot.sendMessage(channelId, message);
                });
            }

            // Save the merged data back to the JSON file
            fs.writeFileSync(outputJSON, JSON.stringify(mergedAddresses, null, 2));

            // Save the found addresses in the .txt file
            if (uniqueNewAddresses.length > 0) {
                const addressesToWrite = uniqueNewAddresses.map(address => address.address);
                if (fs.existsSync(outputTXT)) {
                    // Read the existing addresses from the .txt file
                    const existingTxtContent = fs.readFileSync(outputTXT, 'utf-8');
                    // Combine the new addresses with the existing content
                    const newTxtContent = addressesToWrite.join('\n') + '\n' + existingTxtContent;
                    // Write the combined content back to the .txt file
                    fs.writeFileSync(outputTXT, newTxtContent);
                } else {
                    // If the file doesn't exist initially, simply write the new addresses
                    fs.writeFileSync(outputTXT, addressesToWrite.join('\n') + '\n');
                }
            }
        } else {
            console.log('Invalid data format.');
        }
    } catch (error) {
        if (error.response) {
            if (error.response.status === 429) {
                console.log('API rate limit exceeded. Waiting before retrying...');
            } else {
                console.error(`API error: ${error.response.status}`);
            }
        } else if (error.request) {
            console.error('No response received from the API.');
        } else {
            console.error('Error fetching data:', error.message);
        }
    }
}

// Get the method hash from tx hash
async function extractMethod(transactionHash) {
    try {
        const transaction = await rpcProvider.getTransaction(transactionHash);
        if (transaction) {
            const methodHash = transaction.data.slice(0, 10); // get the first 4 bytes (8 characters) of the input data
            return methodHash;
        } else {
            console.error('Transaction not found.');
            return null;
        }
    } catch (error) {
        console.error(error);
        return null;
    }
}

// Fetch API and node, and save addresses functions
fetchAndSaveAddresses();
listenForTransactions();

// Set up an interval to fetch API and save addresses every x seconds
const updateInterval = updateSeconds * 1000; // convert seconds to ms
setInterval(fetchAndSaveAddresses, updateInterval);
