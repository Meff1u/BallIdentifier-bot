module.exports = {
    name: 'ready',
    once: true,
    async execute(client) {
        console.log(`${client.user.tag}`);
        const urls = {
            BD: 'https://raw.githubusercontent.com/Meff1u/BallIdentifier/refs/heads/main/assets/jsons/BallsdexHashes.json',
            DD: 'https://raw.githubusercontent.com/Meff1u/BallIdentifier/refs/heads/main/assets/jsons/DynastydexHashes.json',
            EB: 'https://raw.githubusercontent.com/Meff1u/BallIdentifier/refs/heads/main/assets/jsons/EmpireballsHashes.json',
            HD: 'https://raw.githubusercontent.com/Meff1u/BallIdentifier/refs/heads/main/assets/jsons/HistoryDexHashes.json',
        };
        client.hashes = {};
        for (const [key, url] of Object.entries(urls)) {
            try {
                const response = await fetch(url);
                if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
                const data = await response.json();
                client.hashes[key] = data;
                console.log(`Fetched ${key} hashes successfully.`);
            } catch (error) {
                console.error(`Failed to fetch ${key} hashes:`, error);
            }
        }
    },
};
