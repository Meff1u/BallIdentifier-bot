const {
    SlashCommandBuilder,
    InteractionContextType,
    MessageFlags,
    ContainerBuilder,
    TextDisplayBuilder,
    SeparatorBuilder,
    SeparatorSpacingSize,
    SectionBuilder,
    ThumbnailBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
} = require("discord.js");

const profiles = require("../utils/profiles");
const SITE_URL = "https://ballidentifier.xyz";

const fmt = (n) => Number(n).toLocaleString("en-US");

module.exports = {
    data: new SlashCommandBuilder()
        .setName("profile")
        .setDescription("Show a public BallIdentifier profile (yours by default).")
        .setContexts(InteractionContextType.BotDM, InteractionContextType.Guild, InteractionContextType.PrivateChannel)
        .addUserOption((option) => option.setName("user").setDescription("Whose profile to show")),

    async execute(interaction) {
        const target = interaction.options.getUser("user") || interaction.user;
        const self = target.id === interaction.user.id;
        const url = `${SITE_URL}/u/${target.id}`;
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const card = await profiles.getProfileCard(target.id);
        if (!card) {
            return interaction.editReply({
                content: self
                    ? `Your profile isn't public yet (or was hidden). You can set it up on ${SITE_URL}/u/${target.id}.`
                    : "This user doesn't have a public BallIdentifier profile.",
            });
        }

        const lines = [];
        if (card.favoriteDex) lines.push(`- Favorite dex: **${card.favoriteDex}**`);
        if (card.showcase.length) lines.push(`- Showcase: ${card.showcase.join(", ")}`);
        if (card.collectionCount !== null) lines.push(`- Collector of \`${fmt(card.collectionCount)}\` ball${card.collectionCount === 1 ? "" : "s"}`);
        if (card.ballsdex) {
            const b = card.ballsdex;
            if (b.totalBalls !== null) lines.push(`- Ballsdex: \`${fmt(b.totalBalls)}\` balls${b.uniqueBalls !== null ? `, \`${fmt(b.uniqueBalls)}\` unique` : ""}${b.specialCount ? `, \`${fmt(b.specialCount)}\` specials` : ""}`);
        }
        if (card.catches) lines.push(`- Last 30 days: \`${fmt(card.catches.count)}\` catches${card.catches.averageMs ? `, average \`${(card.catches.averageMs / 1000).toFixed(2)}s\`` : ""}`);

        const title = `# ${card.name || card.username || target.username}${card.pronouns ? ` · ${card.pronouns}` : ""}`;
        const head = [new TextDisplayBuilder().setContent(`${title}${card.username ? `\n-# @${card.username}` : ""}`)];
        const container = new ContainerBuilder()
            .setAccentColor(0xa020f0)
            .addSectionComponents(new SectionBuilder().addTextDisplayComponents(...head).setThumbnailAccessory(new ThumbnailBuilder().setURL(card.avatarUrl)));
        if (card.bio) container.addTextDisplayComponents(new TextDisplayBuilder().setContent(card.bio.split("\n").map((line) => `> ${line}`).join("\n").slice(0, 700)));
        container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));
        container.addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.length ? lines.join("\n") : "-# Nothing shared on this profile yet."));
        container.addActionRowComponents(new ActionRowBuilder().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("Open full profile").setURL(url)));

        return interaction.editReply({ components: [container], flags: MessageFlags.IsComponentsV2 });
    },
};
